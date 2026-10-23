import { maskPhone, normalizeMobile } from './validation.js';

export const DEMO_ZONE_ID = 900_000_001;
export const DEMO_ZONE_NAME = 'TEST · 25 Mustertermine';

const APPOINTMENT_ID_BASE = 7_000_000_000_000_000;
const PATIENT_NUMBER_BASE = 8_400_000_000_000_000;
const APPOINTMENT_COUNT = 25;

function timeAt(index, offsetMinutes = 0) {
  const minutes = 8 * 60 + index * 15 + offsetMinutes;
  const hours = String(Math.floor(minutes / 60)).padStart(2, '0');
  const remainder = String(minutes % 60).padStart(2, '0');
  return `${hours}:${remainder}:00`;
}

function appointmentIdFor(date, index) {
  const dayNumber = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  return APPOINTMENT_ID_BASE + dayNumber * 100 + index;
}

function createDemoContext(date, index) {
  const hasMobile = index < 22;
  const hasConsent = index < 20 || index >= 22;
  const mobile = hasMobile ? `01500000${String(index + 1).padStart(3, '0')}` : null;
  const appointment = {
    id: appointmentIdFor(date, index),
    date,
    time: timeAt(index),
    endTime: timeAt(index, 15),
    statusCode: 0,
    typeCode: 1,
    zoneId: DEMO_ZONE_ID,
    zoneName: DEMO_ZONE_NAME,
    isDemo: true,
  };

  return {
    patientNumber: PATIENT_NUMBER_BASE + index,
    salutation: 'Frau',
    firstName: 'Testpatientin',
    lastName: String(index + 1).padStart(2, '0'),
    mobile,
    mobileNormalized: normalizeMobile(mobile),
    mobileMasked: maskPhone(mobile),
    hasConsent,
    markerConfigured: true,
    isDemo: true,
    appointment,
  };
}

function publicAppointment(context) {
  return {
    ...context.appointment,
    salutation: context.salutation,
    firstName: context.firstName,
    lastName: context.lastName,
    hasPatient: true,
    hasMobile: Boolean(context.mobileNormalized),
    mobileMasked: context.mobileMasked,
    hasConsent: context.hasConsent,
    markerConfigured: true,
    isDemo: true,
  };
}

export class DemoDataSource {
  constructor(source) {
    this.source = source;
    this.demoContexts = new Map();
  }

  databaseHealth() {
    return this.source.databaseHealth();
  }

  async listZones() {
    const zones = await this.source.listZones();
    return [{ id: DEMO_ZONE_ID, name: DEMO_ZONE_NAME }, ...zones];
  }

  async listAppointments({ from, to, zoneId, limit }) {
    if (zoneId !== DEMO_ZONE_ID) {
      return this.source.listAppointments({ from, to, zoneId, limit });
    }

    const contexts = Array.from(
      { length: Math.min(APPOINTMENT_COUNT, limit) },
      (_, index) => createDemoContext(from, index),
    );
    this.demoContexts = new Map(contexts.map((context) => [context.appointment.id, context]));
    return {
      appointments: contexts.map(publicAppointment),
      truncated: limit < APPOINTMENT_COUNT,
    };
  }

  getPatientReminderContext(patientNumber, from, to) {
    return this.source.getPatientReminderContext(patientNumber, from, to);
  }

  async getReminderContextsByAppointmentIds(appointmentIds) {
    const demo = [];
    const delegatedIds = [];
    for (const id of appointmentIds) {
      const context = this.demoContexts.get(id);
      if (context) demo.push(context);
      else delegatedIds.push(id);
    }
    const delegated = delegatedIds.length
      ? await this.source.getReminderContextsByAppointmentIds(delegatedIds)
      : [];
    return [...demo, ...delegated];
  }

  close() {
    return this.source.close();
  }
}
