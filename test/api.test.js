import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHistoryStore } from '../src/history-store.js';
import { createHttpApplication } from '../src/http-app.js';
import { ReminderService } from '../src/reminder-service.js';
import { SelectionStore } from '../src/selection-store.js';

function localIso(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

test('MEDICAL-OFFICE-Button übergibt nur eine kurzlebige ID und sendet idempotent im Mockmodus', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sms-reminder-api-'));
  const historyStore = await createHistoryStore({ dataDirectory: directory, retentionDays: 90, hashKey: 'integration-secret' });
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const appointment = {
    id: 7,
    date: localIso(tomorrow),
    time: '09:30:00',
    endTime: '09:45:00',
    statusCode: 0,
    typeCode: 1,
    zoneId: 1,
    zoneName: 'Sprechstunde',
  };
  const patientContext = {
    patientNumber: 42,
    salutation: 'Frau',
    firstName: 'Erika',
    lastName: 'Muster',
    mobile: '01701234567',
    mobileNormalized: '+491701234567',
    mobileMasked: '•••• 4567',
    hasConsent: true,
    hasSmsConsent: true,
    hasRcsConsent: false,
    markerConfigured: true,
    smsMarkerConfigured: true,
    rcsMarkerConfigured: true,
    appointments: [appointment],
  };
  const dataSource = {
    async databaseHealth() { return { databaseName: 'test', version: '1', port: 2020, markerConfigured: 1 }; },
    async listZones() { return []; },
    async listAppointments() { return { appointments: [], truncated: false }; },
    async getPatientReminderContext(patientNumber) { return patientNumber === 42 ? patientContext : null; },
    async getReminderContextsByAppointmentIds(ids) {
      return ids.includes(7) ? [{ ...patientContext, appointment }] : [];
    },
  };
  let providerCalls = 0;
  let providerMessage = '';
  const provider = {
    async send({ message }) {
      providerCalls += 1;
      providerMessage = message;
      return { status: 'simulated', providerReference: 'mock-test' };
    },
  };
  const reminderService = new ReminderService({
    dataSource,
    historyStore,
    provider,
    template: 'Praxis Recker: Termin am {datum} um {uhrzeit} Uhr.',
    mode: 'mock',
  });
  const selectionStore = new SelectionStore({ ttlSeconds: 300 });
  const testConfig = {
    app: { host: '127.0.0.1', port: 4173 },
    consent: {
      markerText: 'SMS-Erinnerung erlaubt',
      smsMarkerText: 'SMS-Erinnerung erlaubt',
      rcsMarkerText: 'RCS-Erinnerung mit SMS-Fallback erlaubt',
    },
    integration: { sourceFreshnessSeconds: 30 },
    storage: { historyRetentionDays: 90 },
    sms: {
      mode: 'mock',
      template: 'Praxis Recker: Termin am {datum} um {uhrzeit} Uhr.',
      apiKey: '',
      rcsAgentId: '',
      sender: '',
      rcsTtlMinutes: 60,
      statusSyncMinutes: 5,
    },
    limits: {
      requestsPerMinute: 100,
      requestBodyBytes: 16_384,
      maxRangeDays: 31,
      maxAppointments: 500,
      maxBatchSize: 100,
      singlePatientLookaheadDays: 365,
    },
  };
  let messagingTestCalls = 0;
  let messagingTestShouldFail = false;
  const server = createHttpApplication({
    config: testConfig,
    dataSource,
    historyStore,
    reminderService,
    selectionStore,
    integrationKey: 'integration-secret',
    messagingConnectionTester: async () => {
      messagingTestCalls += 1;
      if (messagingTestShouldFail) throw new Error('provider secret detail');
      return {
        reachable: true,
        journalAccessible: true,
        agentFound: true,
        agent: {
          id: 'praxis-agent',
          displayName: 'Praxis Recker',
          status: 'test',
          isGeneric: false,
        },
        testReady: true,
        productionReady: false,
        smsPermissionTested: false,
        checkedAt: '2026-10-23T18:30:00.000Z',
      };
    },
    updateStatusReader: async () => ({
      currentVersion: '0.3.0',
      latestVersion: '0.3.0',
      state: 'current',
      checkedAt: '2026-10-23T18:00:00.000Z',
      installedAt: null,
      message: 'Version 0.3.0 ist aktuell.',
    }),
    csrfToken: 'csrf-test-token',
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const updateStatusResponse = await fetch(`${base}/api/update-status`);
    assert.equal(updateStatusResponse.status, 200);
    assert.equal((await updateStatusResponse.json()).currentVersion, '0.3.0');

    const initialSettingsResponse = await fetch(`${base}/api/settings`);
    assert.equal(initialSettingsResponse.status, 200);
    const initialSettings = await initialSettingsResponse.json();
    assert.equal(initialSettings.preferences.defaultRangeDays, 7);
    assert.equal(initialSettings.preferences.appointmentsPerPage, 20);
    assert.equal(initialSettings.preferences.preferredZoneId, null);
    assert.equal(initialSettings.preferences.autoLoadAppointments, false);
    assert.equal(initialSettings.system.loopbackOnly, true);
    assert.equal(Object.hasOwn(initialSettings.system, 'password'), false);
    assert.equal(Object.hasOwn(initialSettings.system, 'apiKey'), false);
    assert.equal(initialSettings.system.rcsConsentMarker, 'RCS-Erinnerung mit SMS-Fallback erlaubt');
    assert.equal(initialSettings.system.messaging.mode, 'mock');
    assert.equal(initialSettings.system.messaging.apiKeyConfigured, false);
    assert.equal(initialSettings.system.messaging.fallback, 'sms');
    assert.equal(Object.hasOwn(initialSettings.system.messaging, 'apiKey'), false);

    const messagingTestWithoutCsrf = await fetch(`${base}/api/messaging/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: '{}',
    });
    assert.equal(messagingTestWithoutCsrf.status, 403);
    assert.equal(messagingTestCalls, 0);

    const messagingTestResponse = await fetch(`${base}/api/messaging/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'X-CSRF-Token': 'csrf-test-token',
      },
      body: '{}',
    });
    assert.equal(messagingTestResponse.status, 200);
    const messagingConnection = (await messagingTestResponse.json()).connection;
    assert.equal(messagingTestCalls, 1);
    assert.equal(messagingConnection.agent.status, 'test');
    assert.equal(messagingConnection.testReady, true);
    assert.equal(Object.hasOwn(messagingConnection, 'apiKey'), false);

    messagingTestShouldFail = true;
    const failedMessagingTestResponse = await fetch(`${base}/api/messaging/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'X-CSRF-Token': 'csrf-test-token',
      },
      body: '{}',
    });
    assert.equal(failedMessagingTestResponse.status, 502);
    const failedMessagingTest = await failedMessagingTestResponse.json();
    assert.equal(messagingTestCalls, 2);
    assert.match(failedMessagingTest.error, /seven-Verbindung/);
    assert.equal(failedMessagingTest.error.includes('provider secret detail'), false);

    const settingsWithoutCsrf = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({
        defaultRangeDays: 14,
        appointmentsPerPage: 50,
        preferredZoneId: null,
        autoLoadAppointments: true,
      }),
    });
    assert.equal(settingsWithoutCsrf.status, 403);

    const invalidSettings = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'X-CSRF-Token': 'csrf-test-token',
      },
      body: JSON.stringify({
        defaultRangeDays: 99,
        appointmentsPerPage: 25,
        preferredZoneId: 999,
        autoLoadAppointments: 'ja',
      }),
    });
    assert.equal(invalidSettings.status, 400);

    const unknownZoneSettings = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'X-CSRF-Token': 'csrf-test-token',
      },
      body: JSON.stringify({
        defaultRangeDays: 7,
        appointmentsPerPage: 20,
        preferredZoneId: 999,
        autoLoadAppointments: false,
      }),
    });
    assert.equal(unknownZoneSettings.status, 400);

    const saveSettings = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'X-CSRF-Token': 'csrf-test-token',
      },
      body: JSON.stringify({
        defaultRangeDays: 14,
        appointmentsPerPage: 50,
        preferredZoneId: null,
        autoLoadAppointments: true,
      }),
    });
    assert.equal(saveSettings.status, 200);
    const savedSettings = (await saveSettings.json()).preferences;
    assert.equal(savedSettings.defaultRangeDays, 14);
    assert.equal(savedSettings.appointmentsPerPage, 50);
    assert.equal(savedSettings.autoLoadAppointments, true);

    const templatesResponse = await fetch(`${base}/api/templates`);
    assert.equal(templatesResponse.status, 200);
    const initialTemplates = (await templatesResponse.json()).templates;
    assert.equal(initialTemplates.length, 1);
    assert.equal(initialTemplates[0].isDefault, true);

    const invalidTemplate = await fetch(`${base}/api/templates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'X-CSRF-Token': 'csrf-test-token',
      },
      body: JSON.stringify({ name: 'Ungültig', body: 'Termin ohne Platzhalter' }),
    });
    assert.equal(invalidTemplate.status, 400);

    const createTemplate = await fetch(`${base}/api/templates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'X-CSRF-Token': 'csrf-test-token',
      },
      body: JSON.stringify({
        name: 'Kurze Vorlage',
        body: 'Praxis Recker: Termin am {datum} um {uhrzeit} Uhr.',
      }),
    });
    assert.equal(createTemplate.status, 201);
    const customTemplate = (await createTemplate.json()).template;

    const setDefault = await fetch(`${base}/api/templates/${customTemplate.id}/default`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'X-CSRF-Token': 'csrf-test-token',
      },
      body: '{}',
    });
    assert.equal(setDefault.status, 200);
    const sessionAfterTemplateChange = await fetch(`${base}/api/session`).then((response) => response.json());
    assert.equal(sessionAfterTemplateChange.messageTemplateId, customTemplate.id);

    const unauthorised = await fetch(`${base}/api/integrations/medical-office/selections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientNumber: 42, sourceModifiedAt: new Date().toISOString() }),
    });
    assert.equal(unauthorised.status, 401);

    const selectionResponse = await fetch(`${base}/api/integrations/medical-office/selections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MO-Integration-Key': 'integration-secret' },
      body: JSON.stringify({ patientNumber: 42, sourceModifiedAt: new Date().toISOString() }),
    });
    assert.equal(selectionResponse.status, 201);
    const selection = await selectionResponse.json();
    const openUrl = new URL(selection.openUrl);
    assert.equal(openUrl.pathname, '/single.html');
    assert.equal(openUrl.searchParams.has('patientNumber'), false);
    assert.equal(openUrl.searchParams.get('launch'), selection.launchId);

    const contextResponse = await fetch(`${base}/api/integrations/medical-office/selections/${selection.launchId}`);
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json();
    assert.equal(context.patient.firstName, 'Erika');
    assert.equal(context.patient.mobileMasked, '•••• 4567');
    assert.match(context.appointments[0].messagePreview, /^Praxis Recker: Termin am /);
    assert.equal(Object.hasOwn(context.patient, 'patientNumber'), false);
    assert.equal(Object.hasOwn(context.patient, 'mobile'), false);

    const sendResponse = await fetch(`${base}/api/reminders/single`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'X-CSRF-Token': 'csrf-test-token',
        'Idempotency-Key': 'single-test-1234',
      },
      body: JSON.stringify({ launchId: selection.launchId, appointmentId: 7 }),
    });
    assert.equal(sendResponse.status, 200);
    assert.equal((await sendResponse.json()).sent, 1);
    assert.equal(providerCalls, 1);
    assert.match(providerMessage, /^Praxis Recker: Termin am /);

    const replay = await reminderService.send({
      appointmentIds: [7],
      expectedPatientNumber: 42,
      idempotencyKey: 'single-test-1234',
      source: 'medical-office-button',
      allowedFrom: localIso(new Date()),
      allowedTo: localIso(new Date(Date.now() + 365 * 86_400_000)),
    });
    assert.equal(replay.replayed, true);
    assert.equal(providerCalls, 1);
    assert.equal(historyStore.listRecent().length, 1);

    const consumed = await fetch(`${base}/api/integrations/medical-office/selections/${selection.launchId}`);
    assert.equal(consumed.status, 410);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    historyStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});
