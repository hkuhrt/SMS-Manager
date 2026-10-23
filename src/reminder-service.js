import { randomUUID } from 'node:crypto';
import { ProviderDeliveryUnknownError } from './sms-provider.js';
import { assertSingleSmsFallback, renderNeutralReminder } from './validation.js';

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
  if (!(context.hasRcsConsent || context.hasSmsConsent || context.hasConsent)) {
    return 'Weder der RCS- noch der SMS-Einwilligungsmarker ist gesetzt.';
  }
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
    this.deliverySyncStatus = {
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastChecked: 0,
      lastUpdated: 0,
    };
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
        assertSingleSmsFallback(message);
        const preferredChannel = context.hasRcsConsent ? 'rcs' : 'sms';
        const clientReference = `reminder-${randomUUID()}`;
        try {
          const providerResult = await this.provider.send({
            phone: context.mobileNormalized,
            message,
            preferredChannel,
            clientReference,
            appointmentId,
          });
          const status = providerResult.status || (this.mode === 'mock' ? 'simulated' : 'sent');
          const channel = providerResult.channel || preferredChannel;
          items.push({ appointmentId, status, channel, isRepeat: repeatIds.has(appointmentId) });
          this.historyStore.recordItemResult(reservation.requestId, {
            appointmentId,
            patientNumber: context.patientNumber,
            phone: context.mobileNormalized,
            status,
            providerReference: providerResult.providerReference,
            providerStatus: providerResult.providerStatus,
            clientReference,
            channel,
            source,
            mode: this.mode,
            isDemo: Boolean(context.isDemo || context.appointment?.isDemo),
            isRepeat: repeatIds.has(appointmentId),
          });
        } catch (error) {
          const deliveryUnknown = error instanceof ProviderDeliveryUnknownError || error?.deliveryUnknown === true;
          const status = deliveryUnknown ? 'unknown' : 'failed';
          items.push({ appointmentId, status, channel: preferredChannel, isRepeat: repeatIds.has(appointmentId) });
          this.historyStore.recordItemResult(reservation.requestId, {
            appointmentId,
            patientNumber: context.patientNumber,
            phone: context.mobileNormalized,
            status,
            providerReference: null,
            providerStatus: deliveryUnknown ? 'UNKNOWN' : 'REJECTED',
            clientReference,
            channel: preferredChannel,
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
      const sent = items.filter((item) => ['simulated', 'sent', 'accepted', 'delivered', 'read'].includes(item.status)).length;
      const unknown = items.filter((item) => item.status === 'unknown').length;
      const failed = items.filter((item) => item.status === 'failed').length;
      const skipped = items.filter((item) => item.status === 'skipped').length;
      const response = {
        requestId: reservation.requestId,
        mode: this.mode,
        sent,
        unknown,
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

  async syncDeliveryStatuses() {
    const attemptedAt = new Date().toISOString();
    this.deliverySyncStatus.lastAttemptAt = attemptedAt;
    try {
      if (typeof this.provider.syncStatuses !== 'function') {
        this.deliverySyncStatus = {
          ...this.deliverySyncStatus,
          lastSuccessAt: attemptedAt,
          lastErrorAt: null,
          lastChecked: 0,
          lastUpdated: 0,
        };
        return { checked: 0, updated: 0 };
      }
      const records = this.historyStore.listPendingProviderResults();
      const updates = records.length ? await this.provider.syncStatuses(records) : [];
      let updated = 0;
      for (const update of updates) {
        if (this.historyStore.updateProviderResult(update)) updated += 1;
      }
      this.deliverySyncStatus = {
        ...this.deliverySyncStatus,
        lastSuccessAt: new Date().toISOString(),
        lastErrorAt: null,
        lastChecked: records.length,
        lastUpdated: updated,
      };
      return { checked: records.length, updated };
    } catch (error) {
      this.deliverySyncStatus.lastErrorAt = new Date().toISOString();
      throw error;
    }
  }

  getDeliverySyncStatus() {
    return { ...this.deliverySyncStatus };
  }
}
