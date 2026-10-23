import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMessagingConnectionTester,
  ProviderDeliveryUnknownError,
  ProviderRejectedError,
  SevenMessagingProvider,
} from '../src/sms-provider.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return body; } };
}

function provider(fetchImpl) {
  return new SevenMessagingProvider({
    apiKey: 'test-api-key-123456789',
    rcsAgentId: 'praxis-agent',
    sender: 'Praxis',
    requestTimeoutMs: 1_000,
    rcsTtlMinutes: 60,
    fetchImpl,
  });
}

test('sendet RCS mit explizitem SMS-Fallback und eigener Referenz', async () => {
  let call;
  const service = provider(async (url, options) => {
    call = { url, options };
    return jsonResponse({
      success: '100',
      messages: [{ id: '77233319353', success: true, channel: 'RCS' }],
    });
  });
  const result = await service.send({
    phone: '+491701234567',
    message: 'Praxis: Termin am 31.12.2026 um 09:30 Uhr.',
    preferredChannel: 'rcs',
    clientReference: 'reminder-1234',
  });

  assert.equal(call.url, 'https://gateway.seven.io/api/rcs/messages');
  assert.equal(call.options.headers['X-Api-Key'], 'test-api-key-123456789');
  assert.equal(call.options.body.get('from'), 'praxis-agent');
  assert.equal(call.options.body.get('foreign_id'), 'reminder-1234');
  assert.deepEqual(JSON.parse(call.options.body.get('fallback')), {
    type: 'sms',
    text: 'Praxis: Termin am 31.12.2026 um 09:30 Uhr.',
    from: 'Praxis',
  });
  assert.deepEqual(result, {
    status: 'accepted',
    providerStatus: 'ACCEPTED',
    providerReference: '77233319353',
    clientReference: 'reminder-1234',
    channel: 'rcs',
  });
});

test('sendet bei bestehender SMS-Einwilligung ausschließlich über den SMS-Endpunkt', async () => {
  let call;
  const service = provider(async (url, options) => {
    call = { url, options };
    return jsonResponse({
      success: '100',
      messages: [{ id: '77229318510', success: true, channel: 'SMS' }],
    });
  });
  const result = await service.send({
    phone: '+491701234567',
    message: 'Praxis: Termin am 31.12.2026 um 09:30 Uhr.',
    preferredChannel: 'sms',
    clientReference: 'reminder-5678',
  });

  assert.equal(call.url, 'https://gateway.seven.io/api/sms');
  assert.equal(call.options.body.get('from'), 'Praxis');
  assert.equal(call.options.body.has('fallback'), false);
  assert.equal(result.channel, 'sms');
});

test('unterscheidet sichere Ablehnung von unklarem Netzwerkstatus', async () => {
  const rejected = provider(async () => jsonResponse({}, { ok: false, status: 400 }));
  await assert.rejects(
    rejected.send({ phone: '+491701234567', message: 'Test', clientReference: 'ref-1' }),
    ProviderRejectedError,
  );

  const unknown = provider(async () => { throw new Error('socket closed'); });
  await assert.rejects(
    unknown.send({ phone: '+491701234567', message: 'Test', clientReference: 'ref-2' }),
    ProviderDeliveryUnknownError,
  );
});

test('gleicht Zustellung und tatsächlichen Fallback-Kanal über das Journal ab', async () => {
  const service = provider(async () => jsonResponse([{
    id: '77233319353',
    foreign_id: 'reminder-1234',
    dlr: 'DELIVERED',
    channel: 'SMS',
  }]));
  const updates = await service.syncStatuses([{
    id: 'history-1',
    providerReference: '77233319353',
    clientReference: 'reminder-1234',
    channel: 'rcs',
  }]);
  assert.deepEqual(updates, [{
    recordId: 'history-1',
    status: 'delivered',
    providerStatus: 'DELIVERED',
    providerReference: '77233319353',
    channel: 'sms',
  }]);
});

test('prüft RCS-Agent und Journal lesend, ohne Zugangsdaten zurückzugeben', async () => {
  const calls = [];
  const service = provider(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/rcs/agents')) {
      return jsonResponse({
        agents: [{ id: 'praxis-agent', display_name: 'Praxis Recker', status: 'launched', generic: false }],
      });
    }
    return jsonResponse([]);
  });

  const result = await service.checkConnection();

  assert.deepEqual(calls.map(({ url }) => url), [
    'https://gateway.seven.io/api/rcs/agents',
    'https://gateway.seven.io/api/journal/outbound?limit=1',
  ]);
  assert.equal(calls.every(({ options }) => options.method === 'GET'), true);
  assert.equal(result.reachable, true);
  assert.equal(result.journalAccessible, true);
  assert.equal(result.agentFound, true);
  assert.equal(result.agent.id, 'praxis-agent');
  assert.equal(result.agent.displayName, 'Praxis Recker');
  assert.equal(result.productionReady, true);
  assert.equal(result.smsPermissionTested, false);
  assert.equal(Object.hasOwn(result, 'apiKey'), false);
});

test('meldet fehlende seven-Konfiguration, ohne eine Netzwerkabfrage zu starten', async () => {
  let calls = 0;
  const checkConnection = createMessagingConnectionTester({
    apiKey: '',
    rcsAgentId: '',
    sender: '',
  }, {
    fetchImpl: async () => {
      calls += 1;
      throw new Error('darf nicht aufgerufen werden');
    },
  });

  const result = await checkConnection();

  assert.equal(calls, 0);
  assert.deepEqual(result.missing, ['SEVEN_API_KEY', 'SEVEN_RCS_AGENT_ID', 'SEVEN_SMS_SENDER']);
  assert.equal(result.reachable, false);
  assert.equal(Object.hasOwn(result, 'apiKey'), false);
});
