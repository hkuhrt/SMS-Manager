import { randomUUID } from 'node:crypto';

const FAILURE_STATES = new Set([
  'FAILED', 'NOTDELIVERED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'UNDELIVERABLE',
]);

export class ProviderRejectedError extends Error {
  constructor(message = 'Der Nachrichtendienst hat den Versand abgelehnt.') {
    super(message);
    this.name = 'ProviderRejectedError';
  }
}

export class ProviderDeliveryUnknownError extends Error {
  constructor(message = 'Der Versandstatus ist wegen eines Verbindungsfehlers unbekannt.') {
    super(message);
    this.name = 'ProviderDeliveryUnknownError';
    this.deliveryUnknown = true;
  }
}

function normalizeChannel(value, fallback = 'sms') {
  const channel = String(value || '').toLowerCase();
  return channel === 'rcs' || channel === 'sms' ? channel : fallback;
}

function normalizeJournalStatus(value) {
  const status = String(value || '').toUpperCase();
  if (status === 'READ') return 'read';
  if (status === 'DELIVERED') return 'delivered';
  if (FAILURE_STATES.has(status)) return 'failed';
  return 'accepted';
}

export class MockSmsProvider {
  mode = 'mock';

  async send({ preferredChannel = 'sms', clientReference }) {
    return {
      status: 'simulated',
      providerStatus: 'SIMULATED',
      providerReference: `mock_${randomUUID()}`,
      clientReference,
      channel: preferredChannel,
    };
  }

  async syncStatuses() { return []; }
}

export class SevenMessagingProvider {
  mode = 'seven';

  constructor({
    apiKey,
    rcsAgentId,
    sender,
    requestTimeoutMs = 10_000,
    rcsTtlMinutes = 60,
    baseUrl = 'https://gateway.seven.io',
    fetchImpl = globalThis.fetch,
  }) {
    this.apiKey = apiKey;
    this.rcsAgentId = rcsAgentId;
    this.sender = sender;
    this.requestTimeoutMs = requestTimeoutMs;
    this.rcsTtlMinutes = rcsTtlMinutes;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  async request(path, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...options,
        headers: {
          Accept: 'application/json',
          'X-Api-Key': this.apiKey,
          ...options.headers,
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new ProviderDeliveryUnknownError();
    }

    if (!response.ok) {
      if (response.status >= 500) throw new ProviderDeliveryUnknownError();
      throw new ProviderRejectedError(`Der Nachrichtendienst hat die Anfrage abgelehnt (HTTP ${response.status}).`);
    }
    try {
      return await response.json();
    } catch {
      throw new ProviderDeliveryUnknownError('Die Versandantwort konnte nicht sicher ausgewertet werden.');
    }
  }

  async send({ phone, message, preferredChannel = 'sms', clientReference }) {
    const body = new URLSearchParams({
      to: phone,
      text: message,
      foreign_id: clientReference,
    });
    let path = '/api/sms';
    if (preferredChannel === 'rcs') {
      path = '/api/rcs/messages';
      body.set('from', this.rcsAgentId);
      body.set('ttl', String(this.rcsTtlMinutes));
      body.set('fallback', JSON.stringify({ type: 'sms', text: message, from: this.sender }));
    } else {
      body.set('from', this.sender);
    }

    const result = await this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
    });
    const item = Array.isArray(result?.messages) ? result.messages[0] : null;
    const itemAccepted = item?.success === true || item?.success === 1 || item?.success === 'true';
    if (String(result?.success) !== '100' || !item || !itemAccepted) {
      throw new ProviderRejectedError('Der Nachrichtendienst hat den Versand nicht angenommen.');
    }
    return {
      status: 'accepted',
      providerStatus: 'ACCEPTED',
      providerReference: String(item.id),
      clientReference,
      channel: normalizeChannel(item.channel, preferredChannel),
    };
  }

  async syncStatuses(records) {
    if (!records.length) return [];
    const journal = await this.request('/api/journal/outbound?limit=100');
    if (!Array.isArray(journal)) return [];
    const byProviderReference = new Map(records
      .filter((item) => item.providerReference)
      .map((item) => [String(item.providerReference), item]));
    const byClientReference = new Map(records
      .filter((item) => item.clientReference)
      .map((item) => [String(item.clientReference), item]));
    const updates = [];
    for (const entry of journal) {
      const record = byProviderReference.get(String(entry.id))
        || byClientReference.get(String(entry.foreign_id));
      if (!record) continue;
      const status = normalizeJournalStatus(entry.dlr);
      updates.push({
        recordId: record.id,
        status,
        providerStatus: entry.dlr ? String(entry.dlr).toUpperCase() : 'ACCEPTED',
        providerReference: entry.id ? String(entry.id) : record.providerReference,
        channel: normalizeChannel(entry.channel, record.channel),
      });
    }
    return updates;
  }

  async checkConnection() {
    const agentsResult = await this.request('/api/rcs/agents', { method: 'GET' });
    const journalResult = await this.request('/api/journal/outbound?limit=1', { method: 'GET' });
    const agents = Array.isArray(agentsResult) ? agentsResult : agentsResult?.agents;
    if (!Array.isArray(agents) || !Array.isArray(journalResult)) {
      throw new ProviderRejectedError('Die Antwort des Nachrichtendienstes ist unvollständig.');
    }
    const configuredAgent = agents.find((agent) => String(agent.id) === this.rcsAgentId) || null;
    const agentStatus = configuredAgent ? String(configuredAgent.status || '').toLowerCase() : null;
    return {
      reachable: true,
      journalAccessible: true,
      agentFound: Boolean(configuredAgent),
      agent: configuredAgent ? {
        id: String(configuredAgent.id),
        displayName: String(configuredAgent.display_name || configuredAgent.id),
        status: agentStatus || 'unknown',
        isGeneric: Boolean(configuredAgent.is_generic),
      } : null,
      testReady: agentStatus === 'test' || agentStatus === 'launched' || agentStatus === 'approved',
      productionReady: agentStatus === 'launched' || agentStatus === 'approved',
      smsPermissionTested: false,
      checkedAt: new Date().toISOString(),
    };
  }
}

export function createMessagingConnectionTester(options, { fetchImpl = globalThis.fetch } = {}) {
  return async function testMessagingConnection() {
    const missing = [];
    if (!options.apiKey) missing.push('SEVEN_API_KEY');
    if (!options.rcsAgentId) missing.push('SEVEN_RCS_AGENT_ID');
    if (!options.sender) missing.push('SEVEN_SMS_SENDER');
    if (missing.length) {
      return {
        reachable: false,
        journalAccessible: false,
        agentFound: false,
        agent: null,
        testReady: false,
        productionReady: false,
        smsPermissionTested: false,
        missing,
        checkedAt: new Date().toISOString(),
      };
    }
    const provider = new SevenMessagingProvider({ ...options, fetchImpl });
    return provider.checkConnection();
  };
}

export function createSmsProvider(options) {
  const providerConfig = typeof options === 'string' ? { mode: options } : options;
  if (providerConfig.mode === 'mock') return new MockSmsProvider();
  if (providerConfig.mode === 'seven') return new SevenMessagingProvider(providerConfig);
  throw new Error('Unbekannter Nachrichtendienst.');
}
