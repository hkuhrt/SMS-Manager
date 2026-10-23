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
const smsMode = (process.env.SMS_MODE || 'mock').toLowerCase();

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
    markerText: process.env.CONSENT_MARKER_TEXT || 'SMS-Erinnerung erlaubt',
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
    mode: smsMode,
    template: 'Praxis Recker: Wir erinnern Sie an Ihren Termin am {datum} um {uhrzeit} Uhr. Bei Rückfragen melden Sie sich bitte telefonisch.',
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
  if (!config.consent.markerText.trim()) {
    throw new Error('CONSENT_MARKER_TEXT darf nicht leer sein.');
  }
  if (!/^[\p{L}\p{N} ._-]{1,80}$/u.test(config.consent.markerText)) {
    throw new Error('CONSENT_MARKER_TEXT enthält unzulässige Zeichen.');
  }
  if (config.sms.mode !== 'mock') {
    throw new Error('Aktuell ist ausschließlich SMS_MODE=mock erlaubt. Ein echter Versand ist bewusst gesperrt.');
  }
}

