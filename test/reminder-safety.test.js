import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHistoryStore } from '../src/history-store.js';
import { ReminderConflictError, ReminderService } from '../src/reminder-service.js';

function context(id, { isDemo = false } = {}) {
  return {
    patientNumber: 10_000 + id,
    mobileNormalized: '+491701234567',
    hasConsent: true,
    isDemo,
    appointment: {
      id,
      date: '2030-01-15',
      time: '09:30:00',
      isDemo,
    },
  };
}

function serviceFor({ store, mode = 'mock', send, contexts }) {
  const byId = new Map(contexts.map((item) => [item.appointment.id, item]));
  return new ReminderService({
    dataSource: {
      async getReminderContextsByAppointmentIds(ids) {
        return ids.map((id) => byId.get(id)).filter(Boolean);
      },
    },
    historyStore: store,
    provider: { send },
    template: 'Termin am {datum} um {uhrzeit} Uhr.',
    mode,
  });
}

async function withStore(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'sms-reminder-safety-'));
  const store = await createHistoryStore({ dataDirectory: directory, retentionDays: 90, hashKey: 'safety-key' });
  try {
    await callback(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('blockiert Wiederholungen trotz neuer Idempotenzkennung und trennt Test- und Echtmodus', async () => {
  await withStore(async (store) => {
    let mockCalls = 0;
    const contexts = [context(21)];
    const mockService = serviceFor({
      store,
      contexts,
      send: async () => {
        mockCalls += 1;
        return { status: 'simulated', providerReference: `mock-${mockCalls}` };
      },
    });

    const first = await mockService.send({
      appointmentIds: [21],
      idempotencyKey: 'safety-first-0001',
      source: 'test',
    });
    assert.equal(first.sent, 1);

    await assert.rejects(
      mockService.send({
        appointmentIds: [21],
        idempotencyKey: 'safety-second-0002',
        source: 'test',
      }),
      (error) => error instanceof ReminderConflictError && error.details[0].appointmentId === 21,
    );
    assert.equal(mockCalls, 1);

    const repeat = await mockService.send({
      appointmentIds: [21],
      resendAppointmentIds: [21],
      idempotencyKey: 'safety-repeat-0003',
      source: 'test',
    });
    assert.equal(repeat.sent, 1);
    assert.equal(repeat.items[0].isRepeat, true);
    assert.equal(store.listRecent()[0].isRepeat, true);

    let liveCalls = 0;
    const liveService = serviceFor({
      store,
      mode: 'live',
      contexts,
      send: async () => {
        liveCalls += 1;
        return { status: 'sent', providerReference: 'live-1' };
      },
    });
    const live = await liveService.send({
      appointmentIds: [21],
      idempotencyKey: 'safety-live-0004',
      source: 'test',
    });
    assert.equal(live.sent, 1);
    assert.equal(liveCalls, 1);
  });
});

test('reserviert einen Termin atomar gegen parallele Anfragen', async () => {
  await withStore(async (store) => {
    let releaseFirst;
    const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });
    let providerCalls = 0;
    const service = serviceFor({
      store,
      contexts: [context(22)],
      send: async () => {
        providerCalls += 1;
        await firstMayFinish;
        return { status: 'simulated', providerReference: 'parallel-1' };
      },
    });

    const first = service.send({
      appointmentIds: [22],
      idempotencyKey: 'parallel-first-0001',
      source: 'test',
    });
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(
      service.send({
        appointmentIds: [22],
        idempotencyKey: 'parallel-second-0002',
        source: 'test',
      }),
      ReminderConflictError,
    );
    assert.equal(providerCalls, 1);
    releaseFirst();
    assert.equal((await first).sent, 1);
  });
});

test('protokolliert Teilerfolge und gibt fehlgeschlagene sowie übersprungene Termine frei', async () => {
  await withStore(async (store) => {
    const contexts = [context(31), context(32), context(33, { isDemo: true })];
    const attempts = [];
    const service = serviceFor({
      store,
      contexts,
      send: async ({ appointmentId }) => {
        attempts.push(appointmentId);
        if (appointmentId === 32) throw new Error('provider unavailable');
        return { status: 'simulated', providerReference: `mock-${appointmentId}` };
      },
    });

    const partial = await service.send({
      appointmentIds: [31, 32, 33],
      idempotencyKey: 'partial-first-0001',
      source: 'test',
    });
    assert.deepEqual({ sent: partial.sent, failed: partial.failed, skipped: partial.skipped }, {
      sent: 1,
      failed: 1,
      skipped: 1,
    });
    assert.deepEqual(attempts, [31, 32]);
    assert.deepEqual(partial.items.map((item) => item.status), ['simulated', 'failed', 'skipped']);
    assert.deepEqual(store.listRecent().map((item) => item.status).sort(), ['failed', 'simulated']);

    const retryService = serviceFor({
      store,
      contexts,
      send: async ({ appointmentId }) => ({ status: 'simulated', providerReference: `retry-${appointmentId}` }),
    });
    const retry = await retryService.send({
      appointmentIds: [32, 33],
      idempotencyKey: 'partial-retry-0002',
      source: 'test',
    });
    assert.equal(retry.sent, 2);
    assert.equal(store.listRecent().find((item) => item.appointmentId === 33).isDemo, true);
  });
});
