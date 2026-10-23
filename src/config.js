import { fileURLToPath } from 'node:url';

const integer = (name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
  }
  return value;
};

const schemaName = process.env.DB_NAME || 'medoff';
if (!/^[a-zA-Z0-9_]+$/.test(schemaName)) {
  throw new Error('DB_NAME enthält unzulässige Zeichen.');
}

const kind = (process.env.DB_KIND || 'mariadb').toLowerCase();
if (!['mariadb', 'firebird'].includes(kind)) {
  throw new Error(`DB_KIND=${kind} ist ungültig. Erlaubt sind mariadb oder firebird.`);
}

const defaultDataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
const rawMessageMode = (process.env.MESSAGE_MODE || process.env.SMS_MODE || 'mock').toLowerCase();
const messageMode = rawMessageMode === 'seven-rcs' ? 'seven' : rawMessageMode;
const smsConsentMarker = process.env.SMS_CONSENT_MARKER_TEXT
  || process.env.CONSENT_MARKER_TEXT
  || 'SMS-Erinnerung erlaubt';
const rcsConsentMarker = process.env.RCS_CONSENT_MARKER_TEXT
  || 'RCS-Erinnerung mit SMS-Fallback erlaubt';

export const config = Object.freeze({
  app: {
    host: process.env.APP_HOST || '127.0.0.1',
    port: integer('APP_PORT', 4173, { min: 1024, max: 65535 }),
  },
  database: {
    kind,
    host: process.env.DB_HOST || '127.0.0.1',
    port: integer('DB_PORT', 2020, { min: 1, max: 65535 }),
    name: schemaName,
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    clientPath: process.env.DB_CLIENT_PATH || 'C:\\MEDOFF\\mariadb\\bin\\mysql.exe',
  },
  consent: {
    markerText: smsConsentMarker,
    smsMarkerText: smsConsentMarker,
    rcsMarkerText: rcsConsentMarker,
  },
  integration: {
    keyFile: process.env.MO_INTEGRATION_KEY_FILE || `${defaultDataDirectory}medical-office-integration.key`,
    aktPatPath: process.env.MO_AKTPAT_PATH || 'C:\\MEDOFF\\AKTPAT.TXT',
    selectionTtlSeconds: integer('MO_SELECTION_TTL_SECONDS', 300, { min: 60, max: 900 }),
    sourceFreshnessSeconds: integer('MO_SOURCE_FRESHNESS_SECONDS', 30, { min: 5, max: 120 }),
  },
  storage: {
    dataDirectory: process.env.DATA_DIR || defaultDataDirectory,
    historyRetentionDays: integer('HISTORY_RETENTION_DAYS', 90, { min: 1, max: 365 }),
  },
  sms: {
    mode: messageMode,
    template: 'Praxis Recker: Wir erinnern Sie an Ihren Termin am {datum} um {uhrzeit} Uhr. Bei Rückfragen melden Sie sich bitte telefonisch.',
    apiKey: process.env.SEVEN_API_KEY || '',
    rcsAgentId: process.env.SEVEN_RCS_AGENT_ID || '',
    sender: process.env.SEVEN_SMS_SENDER || '',
    requestTimeoutMs: integer('SEVEN_REQUEST_TIMEOUT_MS', 10_000, { min: 1_000, max: 60_000 }),
    rcsTtlMinutes: integer('SEVEN_RCS_TTL_MINUTES', 60, { min: 1, max: 10_080 }),
    statusSyncMinutes: integer('SEVEN_STATUS_SYNC_MINUTES', 5, { min: 1, max: 1_440 }),
  },
  limits: {
    maxRangeDays: integer('MAX_RANGE_DAYS', 31, { min: 1, max: 92 }),
    maxAppointments: integer('MAX_APPOINTMENTS', 500, { min: 1, max: 2000 }),
    singlePatientLookaheadDays: integer('SINGLE_PATIENT_LOOKAHEAD_DAYS', 365, { min: 7, max: 730 }),
    maxBatchSize: integer('MAX_BATCH_SIZE', 100, { min: 1, max: 500 }),
    requestBodyBytes: integer('MAX_REQUEST_BODY_BYTES', 16_384, { min: 1024, max: 131_072 }),
    requestsPerMinute: integer('MAX_REQUESTS_PER_MINUTE', 60, { min: 10, max: 600 }),
  },
});

export function assertRuntimeConfig() {
  if (config.app.host !== '127.0.0.1' && config.app.host !== 'localhost' && config.app.host !== '::1') {
    throw new Error('APP_HOST muss für diese lokale Anwendung auf Loopback zeigen.');
  }
  if (!config.database.user || !config.database.password) {
    throw new Error('DB_USER und DB_PASSWORD müssen in der lokalen .env-Datei gesetzt sein.');
  }
  for (const [name, value] of [
    ['SMS_CONSENT_MARKER_TEXT', config.consent.smsMarkerText],
    ['RCS_CONSENT_MARKER_TEXT', config.consent.rcsMarkerText],
  ]) {
    if (!value.trim()) throw new Error(`${name} darf nicht leer sein.`);
    if (!/^[\p{L}\p{N} ._-]{1,80}$/u.test(value)) {
      throw new Error(`${name} enthält unzulässige Zeichen.`);
    }
  }
  if (config.consent.smsMarkerText === config.consent.rcsMarkerText) {
    throw new Error('SMS- und RCS-Einwilligungsmarker müssen verschieden sein.');
  }
  if (!['mock', 'seven'].includes(config.sms.mode)) {
    throw new Error('MESSAGE_MODE muss mock oder seven sein.');
  }
  if (config.sms.mode === 'seven') {
    if (config.sms.apiKey.length < 16) throw new Error('SEVEN_API_KEY fehlt oder ist zu kurz.');
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(config.sms.rcsAgentId)) {
      throw new Error('SEVEN_RCS_AGENT_ID fehlt oder enthält unzulässige Zeichen.');
    }
    const validSender = /^\d{1,16}$/.test(config.sms.sender)
      || /^[A-Za-z0-9]{1,11}$/.test(config.sms.sender);
    if (!validSender) {
      throw new Error('SEVEN_SMS_SENDER muss bis zu 11 alphanumerische oder 16 numerische Zeichen haben.');
    }
  }
}

