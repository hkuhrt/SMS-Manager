import { randomBytes } from 'node:crypto';
import { assertRuntimeConfig, config } from './config.js';
import { createDataSource } from './data-source.js';
import { createHistoryStore } from './history-store.js';
import { createHttpApplication } from './http-app.js';
import { loadOrCreateIntegrationKey } from './integration-key.js';
import { ReminderService } from './reminder-service.js';
import { SelectionStore } from './selection-store.js';
import { createMessagingConnectionTester, createSmsProvider } from './sms-provider.js';
import { createUpdateStatusReader } from './update-status.js';

export async function startServer(overrides = {}) {
  assertRuntimeConfig();
  const dataSource = overrides.dataSource || createDataSource();
  const integrationKey = overrides.integrationKey
    || await loadOrCreateIntegrationKey(config.integration.keyFile);
  const historyStore = overrides.historyStore || await createHistoryStore({
    dataDirectory: config.storage.dataDirectory,
    retentionDays: config.storage.historyRetentionDays,
    hashKey: integrationKey,
    defaultTemplate: config.sms.template,
  });
  const selectionStore = overrides.selectionStore || new SelectionStore({
    ttlSeconds: config.integration.selectionTtlSeconds,
  });
  const reminderService = overrides.reminderService || new ReminderService({
    dataSource,
    historyStore,
    provider: createSmsProvider(config.sms),
    template: config.sms.template,
    mode: config.sms.mode === 'mock' ? 'mock' : 'live',
  });
  const updateStatusReader = overrides.updateStatusReader || createUpdateStatusReader({
    dataDirectory: config.storage.dataDirectory,
  });
  const server = createHttpApplication({
    config,
    dataSource,
    historyStore,
    reminderService,
    selectionStore,
    integrationKey,
    updateStatusReader,
    messagingConnectionTester: overrides.messagingConnectionTester
      || createMessagingConnectionTester(config.sms),
    csrfToken: randomBytes(24).toString('base64url'),
  });
  const purgeTimer = setInterval(() => {
    try {
      historyStore.purge();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] HistoryPurgeError`, error.message);
    }
  }, 6 * 60 * 60 * 1_000);
  purgeTimer.unref();
  const statusSyncTimer = config.sms.mode === 'seven'
    ? setInterval(async () => {
      try {
        const result = await reminderService.syncDeliveryStatuses();
        if (result.updated) {
          console.log(`[${new Date().toISOString()}] ${result.updated} Versandstatus aktualisiert.`);
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] DeliveryStatusSyncError`, error.message);
      }
    }, config.sms.statusSyncMinutes * 60_000)
    : null;
  statusSyncTimer?.unref();

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(config.app.port, config.app.host, resolveListen);
  });
  console.log(`SMS Reminder läuft lokal auf http://${config.app.host}:${config.app.port} · ${config.sms.mode === 'mock' ? 'TESTMODUS' : 'SEVEN RCS/SMS'}`);

  async function shutdown() {
    clearInterval(purgeTimer);
    if (statusSyncTimer) clearInterval(statusSyncTimer);
    await new Promise((resolveClose) => server.close(resolveClose));
    historyStore.close();
    await dataSource.close();
  }
  return { server, shutdown };
}

const isMain = process.argv[1]
  ?.replaceAll('\\', '/')
  .toLowerCase()
  .endsWith('/src/server.js');

if (isMain) {
  const runtime = await startServer();
  const shutdown = async () => {
    await runtime.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
