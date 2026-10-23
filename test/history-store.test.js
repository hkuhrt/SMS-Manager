import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createHistoryStore } from '../src/history-store.js';

test('speichert nur minimierte lokale Versanddaten und spielt Idempotenzantworten erneut aus', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sms-reminder-history-'));
  const store = await createHistoryStore({ dataDirectory: directory, retentionDays: 90, hashKey: 'test-key' });
  try {
    const reservation = store.beginRequest({ idempotencyKey: 'request-1234', source: 'test', mode: 'mock' });
    assert.equal(reservation.state, 'new');
    const response = { requestId: reservation.requestId, sent: 1, items: [{ appointmentId: 7, status: 'simulated' }] };
    store.completeRequest(reservation.requestId, response, [{
      appointmentId: 7,
      patientNumber: 99,
      phone: '+491701234567',
      status: 'simulated',
      providerReference: 'mock-1',
      source: 'test',
      mode: 'mock',
    }]);

    assert.deepEqual(store.beginRequest({ idempotencyKey: 'request-1234', source: 'test', mode: 'mock' }), {
      state: 'complete', response,
    });
    const [entry] = store.listRecent();
    assert.equal(entry.phoneMasked, '•••• 4567');
    assert.equal(Object.hasOwn(entry, 'patientNumber'), false);
    assert.equal(Object.hasOwn(entry, 'message'), false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('migriert eine bestehende Historie ohne Datenverlust und baut die Terminsperre auf', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sms-reminder-migration-'));
  const path = join(directory, 'sms-reminder-history.sqlite');
  const legacy = new DatabaseSync(path);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
  legacy.exec(`
    CREATE TABLE send_requests (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
      mode TEXT NOT NULL, status TEXT NOT NULL, response_json TEXT, created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE reminder_history (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, appointment_id INTEGER NOT NULL,
      patient_ref TEXT NOT NULL, phone_last4 TEXT NOT NULL, status TEXT NOT NULL,
      provider_reference TEXT, source TEXT NOT NULL, mode TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
  `);
  legacy.prepare(`
    INSERT INTO send_requests
      (id, idempotency_key, source, mode, status, response_json, created_at, completed_at)
    VALUES ('request-1', 'legacy-request-0001', 'test', 'mock', 'complete', '{}', ?, ?)
  `).run(createdAt, createdAt);
  legacy.prepare(`
    INSERT INTO reminder_history
      (id, request_id, appointment_id, patient_ref, phone_last4, status,
       provider_reference, source, mode, created_at, expires_at)
    VALUES ('history-1', 'request-1', 8500000000000000, 'hashed', '4567',
            'simulated', 'legacy-provider', 'test', 'mock', ?, ?)
  `).run(createdAt, expiresAt);
  legacy.close();

  const store = await createHistoryStore({ dataDirectory: directory, retentionDays: 90, hashKey: 'migration-key' });
  try {
    const [entry] = store.listRecent();
    assert.equal(entry.appointmentId, 8500000000000000);
    assert.equal(entry.isDemo, true);
    assert.equal(entry.isRepeat, false);
    assert.equal(store.appointmentStatuses([8500000000000000], 'mock').get(8500000000000000).status, 'simulated');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('verwaltet lokale SMS-Vorlagen und schützt die Standardvorlage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sms-reminder-templates-'));
  const store = await createHistoryStore({
    dataDirectory: directory,
    retentionDays: 90,
    hashKey: 'template-key',
    defaultTemplate: 'Standard am {datum} um {uhrzeit}.',
  });
  try {
    const original = store.getDefaultTemplate();
    assert.equal(original.body, 'Standard am {datum} um {uhrzeit}.');
    assert.equal(store.deleteTemplate(original.id).reason, 'default');

    const created = store.createTemplate({
      name: 'Kurze Erinnerung',
      body: 'Ihr Termin ist am {datum} um {uhrzeit}.',
    });
    const updated = store.updateTemplate(created.id, {
      name: 'Kurze Terminerinnerung',
      body: 'Wir erinnern an den Termin am {datum} um {uhrzeit}.',
    });
    assert.equal(updated.name, 'Kurze Terminerinnerung');
    assert.equal(store.setDefaultTemplate(created.id).isDefault, true);
    assert.equal(store.getDefaultTemplate().id, created.id);
    assert.equal(store.deleteTemplate(original.id).deleted, true);
    assert.equal(store.listTemplates().length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('legt sichere App-Einstellungen an und speichert sie appweit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sms-reminder-settings-'));
  const store = await createHistoryStore({ dataDirectory: directory, retentionDays: 90, hashKey: 'settings-key' });
  try {
    assert.deepEqual(store.getSettings(), {
      defaultRangeDays: 7,
      appointmentsPerPage: 20,
      preferredZoneId: null,
      autoLoadAppointments: false,
      updatedAt: store.getSettings().updatedAt,
    });
    const saved = store.updateSettings({
      defaultRangeDays: 14,
      appointmentsPerPage: 50,
      preferredZoneId: 8,
      autoLoadAppointments: true,
    });
    assert.equal(saved.defaultRangeDays, 14);
    assert.equal(saved.appointmentsPerPage, 50);
    assert.equal(saved.preferredZoneId, 8);
    assert.equal(saved.autoLoadAppointments, true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('aktualisiert Providerstatus und gibt einen endgültig fehlgeschlagenen Termin wieder frei', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sms-reminder-provider-status-'));
  const store = await createHistoryStore({ dataDirectory: directory, retentionDays: 90, hashKey: 'provider-key' });
  try {
    const request = store.beginRequest({ idempotencyKey: 'provider-status-0001', source: 'test', mode: 'live' });
    store.reserveAppointments({ requestId: request.requestId, appointmentIds: [88], mode: 'live' });
    store.recordItemResult(request.requestId, {
      appointmentId: 88,
      patientNumber: 99,
      phone: '+491701234567',
      status: 'unknown',
      providerStatus: 'UNKNOWN',
      clientReference: 'reminder-88',
      channel: 'rcs',
      source: 'test',
      mode: 'live',
    });
    const [pending] = store.listPendingProviderResults();
    assert.equal(pending.clientReference, 'reminder-88');
    assert.equal(store.updateProviderResult({
      recordId: pending.id,
      status: 'failed',
      providerStatus: 'NOTDELIVERED',
      providerReference: 'seven-88',
      channel: 'sms',
    }), true);
    assert.equal(store.listRecent()[0].status, 'failed');
    assert.equal(store.listRecent()[0].channel, 'sms');
    assert.equal(store.appointmentStatuses([88], 'live').has(88), false);
    assert.equal(store.reserveAppointments({
      requestId: request.requestId,
      appointmentIds: [88],
      mode: 'live',
    }).reserved, true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('stellt nach fehlgeschlagener Wiederholung die vorherige Versandsperre wieder her', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sms-reminder-provider-repeat-'));
  const store = await createHistoryStore({ dataDirectory: directory, retentionDays: 90, hashKey: 'provider-repeat-key' });
  try {
    const first = store.beginRequest({ idempotencyKey: 'provider-repeat-0001', source: 'test', mode: 'live' });
    store.reserveAppointments({ requestId: first.requestId, appointmentIds: [89], mode: 'live' });
    store.recordItemResult(first.requestId, {
      appointmentId: 89, patientNumber: 99, phone: '+491701234567', status: 'delivered',
      providerStatus: 'DELIVERED', clientReference: 'reminder-89-first', channel: 'sms',
      source: 'test', mode: 'live',
    });

    const repeat = store.beginRequest({ idempotencyKey: 'provider-repeat-0002', source: 'test', mode: 'live' });
    assert.equal(store.reserveAppointments({
      requestId: repeat.requestId,
      appointmentIds: [89],
      resendAppointmentIds: [89],
      mode: 'live',
    }).reserved, true);
    store.recordItemResult(repeat.requestId, {
      appointmentId: 89, patientNumber: 99, phone: '+491701234567', status: 'unknown',
      providerStatus: 'UNKNOWN', clientReference: 'reminder-89-repeat', channel: 'rcs',
      source: 'test', mode: 'live', isRepeat: true,
    });
    const pending = store.listPendingProviderResults().find((item) => item.clientReference === 'reminder-89-repeat');
    store.updateProviderResult({ recordId: pending.id, status: 'failed', providerStatus: 'NOTDELIVERED' });

    assert.equal(store.appointmentStatuses([89], 'live').get(89).status, 'delivered');
    const third = store.beginRequest({ idempotencyKey: 'provider-repeat-0003', source: 'test', mode: 'live' });
    assert.equal(store.reserveAppointments({
      requestId: third.requestId,
      appointmentIds: [89],
      mode: 'live',
    }).reserved, false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
