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
