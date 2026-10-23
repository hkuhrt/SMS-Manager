import { renderNeutralReminder } from './validation.js';

export class ReminderConflictError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ReminderConflictError';
    this.status = 409;
    this.details = details;
  }
}

function eligibilityProblem(context) {
  if (!context) return 'Termin wurde nicht gefunden.';
  if (!context.hasConsent) return 'Der Marker „SMS-Erinnerung erlaubt“ ist nicht gesetzt.';
  if (!context.mobileNormalized) return 'Es ist keine gültige Mobilnummer hinterlegt.';
  if (!context.appointment?.date || !/^\d{2}:\d{2}/.test(context.appointment.time || '')) {
    return 'Der Termin hat kein gültiges Datum oder keine gültige Uhrzeit.';
  }
  return null;
}

export class ReminderService {
  constructor({ dataSource, historyStore, provider, template, mode }) {
    this.dataSource = dataSource;
    this.historyStore = historyStore;
    this.provider = provider;
    this.template = template;
    this.mode = mode;
  }

  async send({
    appointmentIds,
    resendAppointmentIds = [],
    expectedPatientNumber = null,
    idempotencyKey,
    source,
    allowedFrom = null,
    allowedTo = null,
    template = this.template,
  }) {
    const uniqueIds = [...new Set(appointmentIds)];
    const resendIds = [...new Set(resendAppointmentIds)];
    const selectedIds = new Set(uniqueIds);
    const invalidResendIds = resendIds.filter((id) => !selectedIds.has(id));
    if (invalidResendIds.length) {
      throw new ReminderConflictError('Wiederholungen dürfen nur für ausgewählte Termine freigegeben werden.',
        invalidResendIds.map((appointmentId) => ({ appointmentId, reason: 'Termin ist nicht Teil der Auswahl.' })));
    }
    const contexts = await this.dataSource.getReminderContextsByAppointmentIds(uniqueIds);
    const byId = new Map(contexts.map((item) => [item.appointment.id, item]));
    const problems = [];

    for (const appointmentId of uniqueIds) {
      const context = byId.get(appointmentId);
      const reason = eligibilityProblem(context);
      if (reason) problems.push({ appointmentId, reason });
      else if (expectedPatientNumber !== null && context.patientNumber !== expectedPatientNumber) {
        problems.push({ appointmentId, reason: 'Der Termin gehört nicht zum übergebenen Patienten.' });
      } else if ((allowedFrom && context.appointment.date < allowedFrom)
        || (allowedTo && context.appointment.date > allowedTo)) {
        problems.push({ appointmentId, reason: 'Der Termin liegt außerhalb des zulässigen Zeitraums.' });
      }
    }
    if (problems.length) {
      throw new ReminderConflictError('Die Erinnerung kann nicht versendet werden. Bitte die Daten neu laden.', problems);
    }

    const reservation = this.historyStore.beginRequest({ idempotencyKey, source, mode: this.mode });
    if (reservation.state === 'complete') return { ...reservation.response, replayed: true };
    if (reservation.state === 'pending') {
      throw new ReminderConflictError('Dieser Versandvorgang wird bereits verarbeitet.');
    }

    const guardReservation = this.historyStore.reserveAppointments({
      requestId: reservation.requestId,
      appointmentIds: uniqueIds,
      mode: this.mode,
      resendAppointmentIds: resendIds,
    });
    if (!guardReservation.reserved) {
      this.historyStore.abandonRequest(reservation.requestId);
      throw new ReminderConflictError(
        'Mindestens ein Termin wurde bereits erinnert oder wird gerade verarbeitet.',
        guardReservation.conflicts,
      );
    }

    const repeatIds = new Set(guardReservation.repeatIds);
    const items = [];
    try {
      for (let index = 0; index < uniqueIds.length; index += 1) {
        const appointmentId = uniqueIds[index];
        const context = byId.get(appointmentId);
        const message = renderNeutralReminder(template, context.appointment);
        try {
          const providerResult = await this.provider.send({
            phone: context.mobileNormalized,
            message,
            appointmentId,
          });
          const status = providerResult.status || (this.mode === 'mock' ? 'simulated' : 'sent');
          items.push({ appointmentId, status, isRepeat: repeatIds.has(appointmentId) });
          this.historyStore.recordItemResult(reservation.requestId, {
            appointmentId,
            patientNumber: context.patientNumber,
            phone: context.mobileNormalized,
            status,
            providerReference: providerResult.providerReference,
            source,
            mode: this.mode,
            isDemo: Boolean(context.isDemo || context.appointment?.isDemo),
            isRepeat: repeatIds.has(appointmentId),
          });
        } catch {
          items.push({ appointmentId, status: 'failed', isRepeat: repeatIds.has(appointmentId) });
          this.historyStore.recordItemResult(reservation.requestId, {
            appointmentId,
            patientNumber: context.patientNumber,
            phone: context.mobileNormalized,
            status: 'failed',
            providerReference: null,
            source,
            mode: this.mode,
            isDemo: Boolean(context.isDemo || context.appointment?.isDemo),
            isRepeat: repeatIds.has(appointmentId),
          });
          const remaining = uniqueIds.slice(index + 1);
          this.historyStore.releaseReservations(reservation.requestId, remaining);
          items.push(...remaining.map((id) => ({ appointmentId: id, status: 'skipped', isRepeat: repeatIds.has(id) })));
          break;
        }
      }
      const sent = items.filter((item) => item.status === 'simulated' || item.status === 'sent').length;
      const failed = items.filter((item) => item.status === 'failed').length;
      const skipped = items.filter((item) => item.status === 'skipped').length;
      const response = {
        requestId: reservation.requestId,
        mode: this.mode,
        sent,
        failed,
        skipped,
        items,
        replayed: false,
      };
      this.historyStore.completeRequest(reservation.requestId, response);
      return response;
    } catch (error) {
      this.historyStore.releaseReservations(reservation.requestId);
      this.historyStore.abandonRequest(reservation.requestId);
      throw error;
    }
  }
}
