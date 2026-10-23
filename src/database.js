import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { config } from './config.js';
import { maskPhone, normalizeMobile } from './validation.js';

const schema = `\`${config.database.name}\``;

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function markerConfiguredSql(markerText) {
  return `EXISTS(
    SELECT 1 FROM ${schema}.markier marker
    WHERE TRIM(marker.FText) = ${sqlString(markerText)}
  )`;
}

function hasConsentSql(markerText, patientAlias = 'p') {
  return `EXISTS(
    SELECT 1
    FROM ${schema}.patmark pm
    INNER JOIN ${schema}.markier marker ON marker.FSurogat = pm.FMarkiernr
    WHERE pm.FPatnr = ${patientAlias}.FSurogat
      AND TRIM(marker.FText) = ${sqlString(markerText)}
  )`;
}

function consentFields(row) {
  const hasSmsConsent = Boolean(Number(row.hasSmsConsent ?? row.hasConsent));
  const hasRcsConsent = Boolean(Number(row.hasRcsConsent));
  const smsMarkerConfigured = Boolean(Number(row.smsMarkerConfigured ?? row.markerConfigured));
  const rcsMarkerConfigured = Boolean(Number(row.rcsMarkerConfigured));
  return {
    hasSmsConsent,
    hasRcsConsent,
    hasConsent: hasSmsConsent || hasRcsConsent,
    smsMarkerConfigured,
    rcsMarkerConfigured,
    markerConfigured: smsMarkerConfigured || rcsMarkerConfigured,
  };
}

function executeJsonQuery(selectSql) {
  const sql = [
    'SET SESSION TRANSACTION READ ONLY',
    'START TRANSACTION READ ONLY',
    selectSql,
    'ROLLBACK',
  ].join('; ');

  return new Promise((resolve, reject) => {
    const child = spawn(
      config.database.clientPath,
      [
        '--protocol=TCP',
        `--host=${config.database.host}`,
        `--port=${config.database.port}`,
        `--user=${config.database.user}`,
        `--database=${config.database.name}`,
        '--connect-timeout=5',
        '--default-character-set=utf8mb4',
        '--batch',
        '--raw',
        '--skip-column-names',
        `--execute=${sql}`,
      ],
      {
        windowsHide: true,
        env: { ...process.env, MYSQL_PWD: config.database.password },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const message = stderr.trim().split(/\r?\n/).slice(-1)[0] || `MariaDB-Client beendet mit Code ${code}.`;
        reject(new Error(message));
        return;
      }

      try {
        resolve(stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => JSON.parse(line)));
      } catch (error) {
        reject(new Error(`MariaDB-Antwort konnte nicht gelesen werden: ${error.message}`));
      }
    });
  });
}

function mapAppointment(row) {
  return {
    id: Number(row.appointmentId),
    date: row.appointmentDate,
    time: row.startTime,
    endTime: row.endTime,
    statusCode: row.statusCode === null ? null : Number(row.statusCode),
    typeCode: row.typeCode === null ? null : Number(row.typeCode),
    zoneId: row.zoneId === null ? null : Number(row.zoneId),
    zoneName: row.zoneName || 'Ohne Zone',
  };
}

function mapReminderContext(row) {
  const mobile = row.mobile || null;
  return {
    patientNumber: Number(row.patientNumber),
    salutation: row.salutation,
    firstName: row.firstName,
    lastName: row.lastName,
    mobile,
    mobileNormalized: normalizeMobile(mobile),
    mobileMasked: maskPhone(mobile),
    ...consentFields(row),
    appointment: mapAppointment(row),
  };
}

export async function databaseHealth() {
  await access(config.database.clientPath);
  const rows = await executeJsonQuery(
    `SELECT JSON_OBJECT(
       'version', VERSION(),
       'databaseName', DATABASE(),
       'port', @@port,
       'smsMarkerConfigured', ${markerConfiguredSql(config.consent.smsMarkerText)},
       'rcsMarkerConfigured', ${markerConfiguredSql(config.consent.rcsMarkerText)}
     )`,
  );
  return rows[0];
}

export async function listZones() {
  const rows = await executeJsonQuery(
    `SELECT JSON_OBJECT(
       'id', FSurogat,
       'name', COALESCE(NULLIF(TRIM(FName), ''), CONCAT('Zone ', FSurogat))
     )
     FROM ${schema}.tzone
     ORDER BY FName`,
  );
  return rows.map((row) => ({ id: Number(row.id), name: row.name }));
}

export async function listAppointments({ from, to, zoneId, limit }) {
  const zoneFilter = zoneId === null ? '' : `AND t.FZonenid = ${zoneId}`;
  const rows = await executeJsonQuery(
    `SELECT JSON_OBJECT(
       'appointmentId', t.FSurogat,
       'appointmentDate', DATE_FORMAT(DATE_ADD('1890-01-01', INTERVAL t.FDatumvon DAY), '%Y-%m-%d'),
       'startTime', TIME_FORMAT(SEC_TO_TIME(NULLIF(t.FZeitvon, -1)), '%H:%i:%s'),
       'endTime', TIME_FORMAT(SEC_TO_TIME(NULLIF(t.FZeitbis, -1)), '%H:%i:%s'),
       'statusCode', t.FStatus,
       'typeCode', t.FTermintyp,
       'zoneId', t.FZonenid,
       'zoneName', COALESCE(NULLIF(TRIM(z.FName), ''), CONCAT('Zone ', t.FZonenid)),
       'patientNumber', p.FSurogat,
       'salutation', NULLIF(TRIM(p.FAnrede), ''),
       'firstName', NULLIF(TRIM(p.FVorname), ''),
       'lastName', NULLIF(TRIM(p.FNachname), ''),
       'mobile', NULLIF(TRIM(p.FTelefonmobil), ''),
       'hasSmsConsent', ${hasConsentSql(config.consent.smsMarkerText, 'p')},
       'hasRcsConsent', ${hasConsentSql(config.consent.rcsMarkerText, 'p')},
       'smsMarkerConfigured', ${markerConfiguredSql(config.consent.smsMarkerText)},
       'rcsMarkerConfigured', ${markerConfiguredSql(config.consent.rcsMarkerText)}
     )
     FROM ${schema}.termin t
     LEFT JOIN ${schema}.patstamm p ON p.FSurogat = t.FPatnr
     LEFT JOIN ${schema}.tzone z ON z.FSurogat = t.FZonenid
     WHERE t.FDatumvon BETWEEN DATEDIFF(${sqlString(from)}, '1890-01-01') AND DATEDIFF(${sqlString(to)}, '1890-01-01')
       ${zoneFilter}
     ORDER BY t.FDatumvon, t.FZeitvon, t.FSurogat
     LIMIT ${limit + 1}`,
  );

  const truncated = rows.length > limit;
  const appointments = rows.slice(0, limit).map((row) => {
    const mobileNormalized = normalizeMobile(row.mobile);
    return {
      ...mapAppointment(row),
      salutation: row.salutation,
      firstName: row.firstName,
      lastName: row.lastName,
      hasPatient: Boolean(row.patientNumber),
      hasMobile: Boolean(mobileNormalized),
      mobileMasked: maskPhone(row.mobile),
      ...consentFields(row),
    };
  });
  return { appointments, truncated };
}

export async function getPatientReminderContext(patientNumber, from, to) {
  const patientRows = await executeJsonQuery(
    `SELECT JSON_OBJECT(
       'patientNumber', p.FSurogat,
       'salutation', NULLIF(TRIM(p.FAnrede), ''),
       'firstName', NULLIF(TRIM(p.FVorname), ''),
       'lastName', NULLIF(TRIM(p.FNachname), ''),
       'mobile', NULLIF(TRIM(p.FTelefonmobil), ''),
       'hasSmsConsent', ${hasConsentSql(config.consent.smsMarkerText, 'p')},
       'hasRcsConsent', ${hasConsentSql(config.consent.rcsMarkerText, 'p')},
       'smsMarkerConfigured', ${markerConfiguredSql(config.consent.smsMarkerText)},
       'rcsMarkerConfigured', ${markerConfiguredSql(config.consent.rcsMarkerText)}
     )
     FROM ${schema}.patstamm p
     WHERE p.FSurogat = ${patientNumber}
     LIMIT 1`,
  );
  if (!patientRows.length) return null;

  const patient = patientRows[0];
  const appointmentRows = await executeJsonQuery(
    `SELECT JSON_OBJECT(
       'appointmentId', t.FSurogat,
       'appointmentDate', DATE_FORMAT(DATE_ADD('1890-01-01', INTERVAL t.FDatumvon DAY), '%Y-%m-%d'),
       'startTime', TIME_FORMAT(SEC_TO_TIME(NULLIF(t.FZeitvon, -1)), '%H:%i:%s'),
       'endTime', TIME_FORMAT(SEC_TO_TIME(NULLIF(t.FZeitbis, -1)), '%H:%i:%s'),
       'statusCode', t.FStatus,
       'typeCode', t.FTermintyp,
       'zoneId', t.FZonenid,
       'zoneName', COALESCE(NULLIF(TRIM(z.FName), ''), CONCAT('Zone ', t.FZonenid))
     )
     FROM ${schema}.termin t
     LEFT JOIN ${schema}.tzone z ON z.FSurogat = t.FZonenid
     WHERE t.FPatnr = ${patientNumber}
       AND t.FDatumvon BETWEEN DATEDIFF(${sqlString(from)}, '1890-01-01') AND DATEDIFF(${sqlString(to)}, '1890-01-01')
     ORDER BY t.FDatumvon, t.FZeitvon, t.FSurogat
     LIMIT ${config.limits.maxAppointments}`,
  );

  const mobile = patient.mobile || null;
  return {
    patientNumber: Number(patient.patientNumber),
    salutation: patient.salutation,
    firstName: patient.firstName,
    lastName: patient.lastName,
    mobile,
    mobileNormalized: normalizeMobile(mobile),
    mobileMasked: maskPhone(mobile),
    ...consentFields(patient),
    appointments: appointmentRows.map(mapAppointment),
  };
}

export async function getReminderContextsByAppointmentIds(appointmentIds) {
  if (!appointmentIds.length) return [];
  const ids = appointmentIds.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error('Ungültige Termin-ID.');

  const rows = await executeJsonQuery(
    `SELECT JSON_OBJECT(
       'appointmentId', t.FSurogat,
       'appointmentDate', DATE_FORMAT(DATE_ADD('1890-01-01', INTERVAL t.FDatumvon DAY), '%Y-%m-%d'),
       'startTime', TIME_FORMAT(SEC_TO_TIME(NULLIF(t.FZeitvon, -1)), '%H:%i:%s'),
       'endTime', TIME_FORMAT(SEC_TO_TIME(NULLIF(t.FZeitbis, -1)), '%H:%i:%s'),
       'statusCode', t.FStatus,
       'typeCode', t.FTermintyp,
       'zoneId', t.FZonenid,
       'zoneName', COALESCE(NULLIF(TRIM(z.FName), ''), CONCAT('Zone ', t.FZonenid)),
       'patientNumber', p.FSurogat,
       'salutation', NULLIF(TRIM(p.FAnrede), ''),
       'firstName', NULLIF(TRIM(p.FVorname), ''),
       'lastName', NULLIF(TRIM(p.FNachname), ''),
       'mobile', NULLIF(TRIM(p.FTelefonmobil), ''),
       'hasSmsConsent', ${hasConsentSql(config.consent.smsMarkerText, 'p')},
       'hasRcsConsent', ${hasConsentSql(config.consent.rcsMarkerText, 'p')},
       'smsMarkerConfigured', ${markerConfiguredSql(config.consent.smsMarkerText)},
       'rcsMarkerConfigured', ${markerConfiguredSql(config.consent.rcsMarkerText)}
     )
     FROM ${schema}.termin t
     INNER JOIN ${schema}.patstamm p ON p.FSurogat = t.FPatnr
     LEFT JOIN ${schema}.tzone z ON z.FSurogat = t.FZonenid
     WHERE t.FSurogat IN (${ids.join(',')})`,
  );
  return rows.map(mapReminderContext);
}

export async function closeDatabase() {
  // Jede Abfrage nutzt einen kurzlebigen lokalen Client-Prozess.
}

export class MariaDbDataSource {
  databaseHealth = databaseHealth;
  listZones = listZones;
  listAppointments = listAppointments;
  getPatientReminderContext = getPatientReminderContext;
  getReminderContextsByAppointmentIds = getReminderContextsByAppointmentIds;
  close = closeDatabase;
}
