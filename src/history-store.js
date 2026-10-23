import { createHmac, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 86_400_000;
const RESERVATION_TIMEOUT_MS = 15 * 60_000;
const LEGACY_DEMO_ID_MIN = 8_500_000_000_000_000;
const LEGACY_DEMO_ID_MAX = LEGACY_DEMO_ID_MIN + 24;
const DEMO_ID_MIN = 7_000_000_000_000_000;
const DEMO_ID_MAX = 7_099_999_999_999_999;
const SUCCESS_STATUSES = new Set(['simulated', 'sent']);
const FALLBACK_TEMPLATE = 'Praxis Recker: Wir erinnern Sie an Ihren Termin am {datum} um {uhrzeit} Uhr. Bei Rückfragen melden Sie sich bitte telefonisch.';

function lastFour(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.slice(-4);
}

function addColumnIfMissing(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function isDemoAppointmentId(value) {
  const id = Number(value);
  return (id >= LEGACY_DEMO_ID_MIN && id <= LEGACY_DEMO_ID_MAX)
    || (id >= DEMO_ID_MIN && id <= DEMO_ID_MAX);
}

export class HistoryStore {
  constructor(database, { retentionDays, hashKey, defaultTemplate = FALLBACK_TEMPLATE }) {
    this.database = database;
    this.retentionDays = retentionDays;
    this.hashKey = hashKey;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS send_requests (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS reminder_history (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        appointment_id INTEGER NOT NULL,
        patient_ref TEXT NOT NULL,
        phone_last4 TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_reference TEXT,
        source TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES send_requests(id)
      );
    `);
    addColumnIfMissing(this.database, 'reminder_history', 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(this.database, 'reminder_history', 'is_repeat', 'INTEGER NOT NULL DEFAULT 0');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS appointment_send_guards (
        appointment_id INTEGER NOT NULL,
        mode TEXT NOT NULL,
        last_success_at TEXT,
        last_success_expires_at TEXT,
        active_request_id TEXT,
        active_since TEXT,
        PRIMARY KEY (appointment_id, mode)
      );
      CREATE TABLE IF NOT EXISTS message_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        body TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reminder_history_created_idx
        ON reminder_history(created_at DESC);
      CREATE INDEX IF NOT EXISTS reminder_history_expires_idx
        ON reminder_history(expires_at);
      CREATE INDEX IF NOT EXISTS reminder_history_appointment_mode_idx
        ON reminder_history(appointment_id, mode, created_at DESC);
    `);
    this.ensureDefaultTemplate(defaultTemplate);
    this.migrateExistingHistory();
    this.purge();
  }

  ensureDefaultTemplate(body) {
    const count = Number(this.database.prepare('SELECT COUNT(*) AS count FROM message_templates').get().count);
    if (count === 0) {
      const now = new Date().toISOString();
      this.database.prepare(`
        INSERT INTO message_templates (id, name, body, is_default, created_at, updated_at)
        VALUES (?, 'Standardvorlage', ?, 1, ?, ?)
      `).run(randomUUID(), body, now, now);
      return;
    }
    const currentDefault = this.database.prepare('SELECT id FROM message_templates WHERE is_default = 1 LIMIT 1').get();
    if (!currentDefault) {
      const first = this.database.prepare('SELECT id FROM message_templates ORDER BY created_at LIMIT 1').get();
      if (first) this.database.prepare('UPDATE message_templates SET is_default = 1 WHERE id = ?').run(first.id);
    }
  }

  listTemplates() {
    return this.database.prepare(`
      SELECT id, name, body, is_default AS isDefault,
             created_at AS createdAt, updated_at AS updatedAt
      FROM message_templates
      ORDER BY is_default DESC, name COLLATE NOCASE
    `).all().map((item) => ({ ...item, isDefault: Boolean(item.isDefault) }));
  }

  getTemplate(id) {
    if (!id) return this.getDefaultTemplate();
    const item = this.database.prepare(`
      SELECT id, name, body, is_default AS isDefault,
             created_at AS createdAt, updated_at AS updatedAt
      FROM message_templates WHERE id = ?
    `).get(id);
    return item ? { ...item, isDefault: Boolean(item.isDefault) } : null;
  }

  getDefaultTemplate() {
    const item = this.database.prepare(`
      SELECT id, name, body, is_default AS isDefault,
             created_at AS createdAt, updated_at AS updatedAt
      FROM message_templates
      ORDER BY is_default DESC, created_at
      LIMIT 1
    `).get();
    return item ? { ...item, isDefault: Boolean(item.isDefault) } : null;
  }

  createTemplate({ name, body }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO message_templates (id, name, body, is_default, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(id, name, body, now, now);
    return this.getTemplate(id);
  }

  updateTemplate(id, { name, body }) {
    const result = this.database.prepare(`
      UPDATE message_templates
      SET name = ?, body = ?, updated_at = ?
      WHERE id = ?
    `).run(name, body, new Date().toISOString(), id);
    return result.changes ? this.getTemplate(id) : null;
  }

  setDefaultTemplate(id) {
    if (!this.getTemplate(id)) return null;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('UPDATE message_templates SET is_default = 0 WHERE is_default = 1').run();
      this.database.prepare('UPDATE message_templates SET is_default = 1, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.getTemplate(id);
  }

  deleteTemplate(id) {
    const template = this.getTemplate(id);
    if (!template) return { deleted: false, reason: 'missing' };
    if (template.isDefault) return { deleted: false, reason: 'default' };
    this.database.prepare('DELETE FROM message_templates WHERE id = ?').run(id);
    return { deleted: true };
  }

  migrateExistingHistory() {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        UPDATE reminder_history
        SET is_demo = 1
        WHERE (appointment_id BETWEEN ? AND ?)
           OR (appointment_id BETWEEN ? AND ?)
      `).run(LEGACY_DEMO_ID_MIN, LEGACY_DEMO_ID_MAX, DEMO_ID_MIN, DEMO_ID_MAX);
      this.database.exec(`
        INSERT INTO appointment_send_guards (
          appointment_id, mode, last_success_at, last_success_expires_at,
          active_request_id, active_since
        )
        SELECT h.appointment_id, h.mode, h.created_at, h.expires_at, NULL, NULL
        FROM reminder_history h
        INNER JOIN (
          SELECT appointment_id, mode, MAX(created_at) AS latest
          FROM reminder_history
          WHERE status IN ('simulated', 'sent')
          GROUP BY appointment_id, mode
        ) latest
          ON latest.appointment_id = h.appointment_id
         AND latest.mode = h.mode
         AND latest.latest = h.created_at
        WHERE h.status IN ('simulated', 'sent')
        ON CONFLICT(appointment_id, mode) DO UPDATE SET
          last_success_at = excluded.last_success_at,
          last_success_expires_at = excluded.last_success_expires_at
      `);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  beginRequest({ idempotencyKey, source, mode }) {
    const existing = this.database.prepare(
      'SELECT id, status, response_json AS responseJson, created_at AS createdAt FROM send_requests WHERE idempotency_key = ?',
    ).get(idempotencyKey);

    if (existing?.status === 'complete' && existing.responseJson) {
      return { state: 'complete', response: JSON.parse(existing.responseJson) };
    }
    if (existing) return { state: 'pending' };

    const requestId = randomUUID();
    this.database.prepare(`
      INSERT INTO send_requests (id, idempotency_key, source, mode, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(requestId, idempotencyKey, source, mode, new Date().toISOString());
    return { state: 'new', requestId };
  }

  reserveAppointments({ requestId, appointmentIds, mode, resendAppointmentIds = [] }) {
    const now = new Date();
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - RESERVATION_TIMEOUT_MS).toISOString();
    const resend = new Set(resendAppointmentIds);
    const conflicts = [];
    const repeatIds = [];

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        UPDATE appointment_send_guards
        SET active_request_id = NULL, active_since = NULL
        WHERE active_since IS NOT NULL AND active_since <= ?
      `).run(staleBefore);

      const getGuard = this.database.prepare(`
        SELECT last_success_at AS lastSuccessAt,
               last_success_expires_at AS lastSuccessExpiresAt,
               active_request_id AS activeRequestId
        FROM appointment_send_guards
        WHERE appointment_id = ? AND mode = ?
      `);

      for (const appointmentId of appointmentIds) {
        const guard = getGuard.get(appointmentId, mode);
        if (guard?.activeRequestId && guard.activeRequestId !== requestId) {
          conflicts.push({ appointmentId, reason: 'Dieser Termin wird gerade in einem anderen Versand verarbeitet.' });
          continue;
        }
        if (guard?.lastSuccessExpiresAt && guard.lastSuccessExpiresAt > nowIso) {
          if (!resend.has(appointmentId)) {
            conflicts.push({ appointmentId, reason: 'Für diesen Termin wurde in diesem Versandmodus bereits eine Erinnerung verarbeitet.' });
          } else {
            repeatIds.push(appointmentId);
          }
        }
      }

      if (!conflicts.length) {
        const reserve = this.database.prepare(`
          INSERT INTO appointment_send_guards (
            appointment_id, mode, active_request_id, active_since
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(appointment_id, mode) DO UPDATE SET
            active_request_id = excluded.active_request_id,
            active_since = excluded.active_since
        `);
        for (const appointmentId of appointmentIds) {
          reserve.run(appointmentId, mode, requestId, nowIso);
        }
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return { reserved: conflicts.length === 0, conflicts, repeatIds };
  }

  recordItemResult(requestId, record) {
    const createdAt = new Date();
    const createdAtIso = createdAt.toISOString();
    const expiresAt = new Date(createdAt.getTime() + this.retentionDays * DAY_MS).toISOString();
    const successful = SUCCESS_STATUSES.has(record.status);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO reminder_history (
          id, request_id, appointment_id, patient_ref, phone_last4, status,
          provider_reference, source, mode, created_at, expires_at, is_demo, is_repeat
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        requestId,
        record.appointmentId,
        this.patientReference(record.patientNumber),
        lastFour(record.phone),
        record.status,
        record.providerReference || null,
        record.source,
        record.mode,
        createdAtIso,
        expiresAt,
        record.isDemo ? 1 : 0,
        record.isRepeat ? 1 : 0,
      );

      if (successful) {
        this.database.prepare(`
          INSERT INTO appointment_send_guards (
            appointment_id, mode, last_success_at, last_success_expires_at,
            active_request_id, active_since
          ) VALUES (?, ?, ?, ?, NULL, NULL)
          ON CONFLICT(appointment_id, mode) DO UPDATE SET
            last_success_at = excluded.last_success_at,
            last_success_expires_at = excluded.last_success_expires_at,
            active_request_id = NULL,
            active_since = NULL
        `).run(record.appointmentId, record.mode, createdAtIso, expiresAt);
      } else {
        this.database.prepare(`
          UPDATE appointment_send_guards
          SET active_request_id = NULL, active_since = NULL
          WHERE appointment_id = ? AND mode = ? AND active_request_id = ?
        `).run(record.appointmentId, record.mode, requestId);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  releaseReservations(requestId, appointmentIds = null) {
    if (appointmentIds && appointmentIds.length === 0) return;
    if (appointmentIds) {
      const release = this.database.prepare(`
        UPDATE appointment_send_guards
        SET active_request_id = NULL, active_since = NULL
        WHERE appointment_id = ? AND active_request_id = ?
      `);
      this.database.exec('BEGIN IMMEDIATE');
      try {
        for (const appointmentId of appointmentIds) release.run(appointmentId, requestId);
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
      return;
    }
    this.database.prepare(`
      UPDATE appointment_send_guards
      SET active_request_id = NULL, active_since = NULL
      WHERE active_request_id = ?
    `).run(requestId);
  }

  completeRequest(requestId, response, records = []) {
    for (const record of records) this.recordItemResult(requestId, record);
    const completedAt = new Date().toISOString();
    this.database.prepare(`
      UPDATE send_requests
      SET status = 'complete', response_json = ?, completed_at = ?
      WHERE id = ?
    `).run(JSON.stringify(response), completedAt, requestId);
  }

  abandonRequest(requestId) {
    this.releaseReservations(requestId);
    this.database.prepare("DELETE FROM send_requests WHERE id = ? AND status = 'pending'").run(requestId);
  }

  patientReference(patientNumber) {
    return createHmac('sha256', this.hashKey).update(String(patientNumber)).digest('hex').slice(0, 24);
  }

  appointmentStatuses(appointmentIds, mode) {
    if (!appointmentIds.length) return new Map();
    const get = this.database.prepare(`
      SELECT g.last_success_at AS remindedAt,
             (
               SELECT h.status
               FROM reminder_history h
               WHERE h.appointment_id = g.appointment_id
                 AND h.mode = g.mode
                 AND h.status IN ('simulated', 'sent')
               ORDER BY h.created_at DESC
               LIMIT 1
             ) AS status,
             (
               SELECT COUNT(*)
               FROM reminder_history h
               WHERE h.appointment_id = g.appointment_id
                 AND h.mode = g.mode
                 AND h.status IN ('simulated', 'sent')
             ) AS successCount,
             (
               SELECT MAX(h.is_demo)
               FROM reminder_history h
               WHERE h.appointment_id = g.appointment_id AND h.mode = g.mode
             ) AS isDemo
      FROM appointment_send_guards g
      WHERE g.appointment_id = ? AND g.mode = ?
        AND g.last_success_expires_at > ?
    `);
    const now = new Date().toISOString();
    const result = new Map();
    for (const appointmentId of appointmentIds) {
      const row = get.get(appointmentId, mode, now);
      if (!row?.remindedAt) continue;
      result.set(appointmentId, {
        status: row.status || (mode === 'mock' ? 'simulated' : 'sent'),
        remindedAt: row.remindedAt,
        isDemo: Boolean(row.isDemo) || isDemoAppointmentId(appointmentId),
        repeatCount: Math.max(0, Number(row.successCount || 0) - 1),
      });
    }
    return result;
  }

  listRecent(limit = 50) {
    return this.database.prepare(`
      SELECT appointment_id AS appointmentId,
             phone_last4 AS phoneLast4,
             status,
             source,
             mode,
             created_at AS createdAt,
             is_demo AS isDemo,
             is_repeat AS isRepeat
      FROM reminder_history
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit).map((row) => ({
      ...row,
      appointmentId: Number(row.appointmentId),
      phoneMasked: row.phoneLast4 ? `•••• ${row.phoneLast4}` : null,
      isDemo: Boolean(row.isDemo),
      isRepeat: Boolean(row.isRepeat),
    }));
  }

  purge() {
    const now = new Date();
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - RESERVATION_TIMEOUT_MS).toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM reminder_history WHERE expires_at <= ?').run(nowIso);
      this.database.prepare(`
        UPDATE appointment_send_guards
        SET active_request_id = NULL, active_since = NULL
        WHERE active_since IS NOT NULL AND active_since <= ?
      `).run(staleBefore);
      this.database.prepare(`
        DELETE FROM appointment_send_guards
        WHERE active_request_id IS NULL
          AND (last_success_expires_at IS NULL OR last_success_expires_at <= ?)
      `).run(nowIso);
      this.database.prepare(`
        DELETE FROM send_requests
        WHERE status = 'complete'
          AND id NOT IN (SELECT DISTINCT request_id FROM reminder_history)
      `).run();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

export async function createHistoryStore({
  dataDirectory,
  retentionDays,
  hashKey,
  defaultTemplate = FALLBACK_TEMPLATE,
}) {
  await mkdir(dataDirectory, { recursive: true });
  const database = new DatabaseSync(join(dataDirectory, 'sms-reminder-history.sqlite'));
  return new HistoryStore(database, {
    retentionDays,
    hashKey,
    defaultTemplate,
  });
}
