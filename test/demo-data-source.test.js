import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_ZONE_ID, DEMO_ZONE_NAME, DemoDataSource } from '../src/demo-data-source.js';

function baseSource() {
  return {
    listAppointmentCalls: 0,
    async databaseHealth() { return { databaseName: 'test' }; },
    async listZones() { return [{ id: 1, name: 'Sprechstunde' }]; },
    async listAppointments() {
      this.listAppointmentCalls += 1;
      return { appointments: [], truncated: false };
    },
    async getPatientReminderContext() { return null; },
    async getReminderContextsByAppointmentIds() { return []; },
    async close() {},
  };
}

test('stellt im Mockmodus eine klar getrennte Testzone bereit', async () => {
  const base = baseSource();
  const source = new DemoDataSource(base);
  const zones = await source.listZones();

  assert.deepEqual(zones[0], { id: DEMO_ZONE_ID, name: DEMO_ZONE_NAME });
  assert.deepEqual(zones[1], { id: 1, name: 'Sprechstunde' });
});

test('liefert 25 erfundene Patientinnen an genau einem gewählten Tag', async () => {
  const base = baseSource();
  const source = new DemoDataSource(base);
  const result = await source.listAppointments({
    from: '2026-10-26',
    to: '2026-10-30',
    zoneId: DEMO_ZONE_ID,
    limit: 500,
  });

  assert.equal(base.listAppointmentCalls, 0);
  assert.equal(result.appointments.length, 25);
  assert.equal(result.truncated, false);
  assert.equal(result.appointments.every((item) => item.date === '2026-10-26'), true);
  assert.equal(result.appointments.every((item) => item.zoneId === DEMO_ZONE_ID), true);
  assert.equal(result.appointments.every((item) => item.firstName === 'Testpatientin'), true);
  assert.equal(result.appointments.filter((item) => item.hasMobile && item.hasConsent).length, 20);
  assert.equal(result.appointments.filter((item) => !item.hasMobile).length, 3);
  assert.equal(result.appointments.filter((item) => item.hasMobile && !item.hasConsent).length, 2);
});

test('löst Demo-Termine für den simulierten Versand erneut auf', async () => {
  const source = new DemoDataSource(baseSource());
  const { appointments } = await source.listAppointments({
    from: '2026-10-26',
    to: '2026-10-26',
    zoneId: DEMO_ZONE_ID,
    limit: 500,
  });
  const selected = appointments.filter((item) => item.hasMobile && item.hasConsent).slice(0, 2);
  const contexts = await source.getReminderContextsByAppointmentIds(selected.map((item) => item.id));

  assert.equal(contexts.length, 2);
  assert.equal(contexts.every((item) => item.mobileNormalized?.startsWith('+49')), true);
  assert.equal(contexts.every((item) => item.appointment.date === '2026-10-26'), true);
});
