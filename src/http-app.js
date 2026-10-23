import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFreshSourceTimestamp } from './aktpat.js';
import { integrationKeyMatches } from './integration-key.js';
import { ReminderConflictError } from './reminder-service.js';
import { SelectionError } from './selection-store.js';
import {
  InputError,
  parseOptionalPositiveInt,
  parsePatientNumber,
  parsePositiveInt,
  renderNeutralReminder,
  validateDateRange,
  validateIdempotencyKey,
  validateLaunchId,
} from './validation.js';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
]);

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

class RateLimiter {
  constructor(limit, now = () => Date.now()) {
    this.limit = limit;
    this.now = now;
    this.buckets = new Map();
  }

  check(bucket) {
    const minute = Math.floor(this.now() / 60_000);
    const current = this.buckets.get(bucket);
    if (!current || current.minute !== minute) {
      this.buckets.set(bucket, { minute, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > this.limit) throw new HttpError(429, 'Zu viele Anfragen. Bitte kurz warten.');
  }
}

function json(response, statusCode, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    ...securityHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function isLoopback(value) {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function hostIsLoopback(host) {
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || isLoopback(hostname);
  } catch {
    return false;
  }
}

function originIsLocal(origin) {
  try {
    const value = new URL(origin);
    return value.protocol === 'http:' && (value.hostname === 'localhost' || isLoopback(value.hostname));
  } catch {
    return false;
  }
}

function requireBrowserPostSecurity(request, csrfToken) {
  if (!originIsLocal(request.headers.origin)) throw new HttpError(403, 'Die Anfrage stammt nicht aus der lokalen Anwendung.');
  if (request.headers['x-csrf-token'] !== csrfToken) throw new HttpError(403, 'Die Sicherheitskennung ist ungültig. Bitte die Seite neu laden.');
}

async function readJsonBody(request, maxBytes) {
  const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'Content-Type muss application/json sein.');

  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new HttpError(413, 'Die Anfrage ist zu groß.');
  }
  try {
    const parsed = JSON.parse(body || '{}');
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('object required');
    return parsed;
  } catch {
    throw new HttpError(400, 'Die JSON-Anfrage ist ungültig.');
  }
}

function localIso(date = new Date()) {
  const copy = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return copy.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function appointmentCanBeReminded(appointment) {
  return Boolean(appointment?.date && /^\d{2}:\d{2}/.test(appointment.time || ''));
}

function validateTemplateId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) {
    throw new InputError('Die Vorlagen-ID ist ungültig.');
  }
  return value;
}

function validateTemplateInput(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const templateBody = typeof body.body === 'string' ? body.body.trim() : '';
  if (name.length < 1 || name.length > 60) {
    throw new InputError('Der Vorlagenname muss zwischen 1 und 60 Zeichen lang sein.');
  }
  if (templateBody.length < 10 || templateBody.length > 320) {
    throw new InputError('Der SMS-Text muss zwischen 10 und 320 Zeichen lang sein.');
  }
  const placeholders = [...templateBody.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  if (placeholders.some((value) => !['datum', 'uhrzeit'].includes(value))) {
    throw new InputError('Erlaubte Platzhalter sind ausschließlich {datum} und {uhrzeit}.');
  }
  if (!templateBody.includes('{datum}') || !templateBody.includes('{uhrzeit}')) {
    throw new InputError('Die Vorlage muss die Platzhalter {datum} und {uhrzeit} enthalten.');
  }
  return { name, body: templateBody };
}

function templateForRequest(historyStore, templateId) {
  const template = templateId === undefined
    ? historyStore.getDefaultTemplate()
    : historyStore.getTemplate(validateTemplateId(templateId));
  if (!template) throw new HttpError(404, 'Die ausgewählte SMS-Vorlage wurde nicht gefunden.');
  return template;
}

function publicPatientContext(context, template) {
  const appointments = context.appointments.filter(appointmentCanBeReminded);
  const reasons = [];
  if (!context.markerConfigured) reasons.push('Der Marker „SMS-Erinnerung erlaubt“ ist in MEDICAL OFFICE noch nicht angelegt.');
  else if (!context.hasConsent) reasons.push('Beim Patienten ist der Marker „SMS-Erinnerung erlaubt“ nicht gesetzt.');
  if (!context.mobileNormalized) reasons.push('Es ist keine gültige Mobilnummer im Mobilfunkfeld hinterlegt.');
  if (!appointments.length) reasons.push('In den kommenden 365 Tagen wurde kein Termin mit gültiger Uhrzeit gefunden.');

  return {
    patient: {
      salutation: context.salutation,
      firstName: context.firstName,
      lastName: context.lastName,
      mobileMasked: context.mobileMasked,
      hasConsent: context.hasConsent,
      markerConfigured: context.markerConfigured,
    },
    appointments: appointments.map((appointment) => ({
      ...appointment,
      messagePreview: renderNeutralReminder(template, appointment),
    })),
    eligible: reasons.length === 0,
    reasons,
  };
}

function publicError(error) {
  if (error instanceof HttpError || error instanceof SelectionError || error instanceof ReminderConflictError) {
    return { status: error.status || 400, message: error.message, details: error.details };
  }
  if (error instanceof InputError) return { status: 400, message: error.message };
  console.error(`[${new Date().toISOString()}]`, error.name, error.message);
  return {
    status: 503,
    message: 'Die lokale Verarbeitung ist fehlgeschlagen. Bitte Datenbank und Windows-Dienst prüfen.',
  };
}

export function createHttpApplication({
  config,
  dataSource,
  historyStore,
  reminderService,
  selectionStore,
  integrationKey,
  updateStatusReader = async () => ({
    currentVersion: '0.0.0',
    latestVersion: null,
    state: 'never-checked',
    checkedAt: null,
    installedAt: null,
    message: 'Es wurde noch nicht nach Updates gesucht.',
  }),
  csrfToken = randomBytes(24).toString('base64url'),
}) {
  const rateLimiter = new RateLimiter(config.limits.requestsPerMinute);

  async function handleApi(request, response, url) {
    rateLimiter.check(`${request.socket.remoteAddress}:${url.pathname.startsWith('/api/integrations/') ? 'integration' : 'app'}`);

    if (request.method === 'GET' && url.pathname === '/api/session') {
      const defaultTemplate = historyStore.getDefaultTemplate();
      json(response, 200, {
        csrfToken,
        smsMode: config.sms.mode,
        consentMarker: config.consent.markerText,
        messageTemplate: defaultTemplate?.body || config.sms.template,
        messageTemplateId: defaultTemplate?.id || null,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/update-status') {
      json(response, 200, await updateStatusReader());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/templates') {
      json(response, 200, { templates: historyStore.listTemplates(), maxTemplates: 20 });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/templates') {
      requireBrowserPostSecurity(request, csrfToken);
      const body = await readJsonBody(request, config.limits.requestBodyBytes);
      if (historyStore.listTemplates().length >= 20) {
        throw new HttpError(409, 'Es können höchstens 20 SMS-Vorlagen gespeichert werden.');
      }
      try {
        json(response, 201, { template: historyStore.createTemplate(validateTemplateInput(body)) });
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) throw new HttpError(409, 'Dieser Vorlagenname ist bereits vergeben.');
        throw error;
      }
      return;
    }

    const templateMatch = url.pathname.match(/^\/api\/templates\/([a-f0-9-]{36})$/i);
    if (request.method === 'PUT' && templateMatch) {
      requireBrowserPostSecurity(request, csrfToken);
      const body = await readJsonBody(request, config.limits.requestBodyBytes);
      try {
        const template = historyStore.updateTemplate(validateTemplateId(templateMatch[1]), validateTemplateInput(body));
        if (!template) throw new HttpError(404, 'Die SMS-Vorlage wurde nicht gefunden.');
        json(response, 200, { template });
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) throw new HttpError(409, 'Dieser Vorlagenname ist bereits vergeben.');
        throw error;
      }
      return;
    }

    const defaultTemplateMatch = url.pathname.match(/^\/api\/templates\/([a-f0-9-]{36})\/default$/i);
    if (request.method === 'POST' && defaultTemplateMatch) {
      requireBrowserPostSecurity(request, csrfToken);
      await readJsonBody(request, config.limits.requestBodyBytes);
      const template = historyStore.setDefaultTemplate(validateTemplateId(defaultTemplateMatch[1]));
      if (!template) throw new HttpError(404, 'Die SMS-Vorlage wurde nicht gefunden.');
      json(response, 200, { template });
      return;
    }

    if (request.method === 'DELETE' && templateMatch) {
      requireBrowserPostSecurity(request, csrfToken);
      const result = historyStore.deleteTemplate(validateTemplateId(templateMatch[1]));
      if (result.reason === 'missing') throw new HttpError(404, 'Die SMS-Vorlage wurde nicht gefunden.');
      if (result.reason === 'default') throw new HttpError(409, 'Die Standardvorlage kann nicht gelöscht werden. Bitte zuerst eine andere Vorlage als Standard festlegen.');
      json(response, 200, { status: 'deleted' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      const health = await dataSource.databaseHealth();
      json(response, 200, {
        status: 'ok',
        database: health.databaseName,
        version: health.version,
        port: Number(health.port),
        readOnly: true,
        smsMode: config.sms.mode,
        markerConfigured: Boolean(Number(health.markerConfigured)),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/zones') {
      json(response, 200, { zones: await dataSource.listZones() });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/appointments') {
      const range = validateDateRange(url.searchParams.get('from'), url.searchParams.get('to'), config.limits.maxRangeDays);
      const zoneId = parseOptionalPositiveInt(url.searchParams.get('zone'), 'Zone');
      const result = await dataSource.listAppointments({
        from: range.from,
        to: range.to,
        zoneId,
        limit: config.limits.maxAppointments,
      });
      const withPatient = result.appointments.filter((item) => item.hasPatient).length;
      const withMobile = result.appointments.filter((item) => item.hasMobile).length;
      const eligible = result.appointments.filter((item) => item.hasPatient && item.hasMobile && item.hasConsent).length;
      const reminderStatuses = historyStore.appointmentStatuses(
        result.appointments.map((item) => item.id),
        config.sms.mode,
      );
      const appointments = result.appointments.map((item) => {
        let reminderStatus = reminderStatuses.get(item.id) || {
          status: 'ready',
          remindedAt: null,
          isDemo: Boolean(item.isDemo),
          repeatCount: 0,
        };
        if (!item.hasPatient) reminderStatus = { ...reminderStatus, status: 'patient-missing' };
        else if (!item.hasMobile) reminderStatus = { ...reminderStatus, status: 'mobile-missing' };
        else if (!item.hasConsent) reminderStatus = { ...reminderStatus, status: 'consent-missing' };
        return { ...item, reminderStatus };
      });
      json(response, 200, {
        ...result,
        appointments,
        summary: {
          total: result.appointments.length,
          withPatient,
          withMobile,
          missingMobile: result.appointments.length - withMobile,
          eligible,
        },
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/history') {
      const limit = Math.min(parseOptionalPositiveInt(url.searchParams.get('limit'), 'Limit') || 50, 100);
      json(response, 200, { history: historyStore.listRecent(limit), retentionDays: config.storage.historyRetentionDays });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/integrations/medical-office/selections') {
      if (!integrationKeyMatches(integrationKey, request.headers['x-mo-integration-key'])) {
        throw new HttpError(401, 'Die MEDICAL-OFFICE-Übergabe ist nicht autorisiert.');
      }
      const body = await readJsonBody(request, config.limits.requestBodyBytes);
      const patientNumber = parsePatientNumber(body.patientNumber);
      const sourceModifiedAt = assertFreshSourceTimestamp(body.sourceModifiedAt, {
        maxAgeSeconds: config.integration.sourceFreshnessSeconds,
      });
      const selection = selectionStore.create({ patientNumber, sourceModifiedAt });
      const openUrl = `http://127.0.0.1:${config.app.port}/single.html?launch=${selection.id}`;
      json(response, 201, {
        launchId: selection.id,
        expiresAt: new Date(selection.expiresAt).toISOString(),
        openUrl,
      });
      return;
    }

    const selectionMatch = url.pathname.match(/^\/api\/integrations\/medical-office\/selections\/([A-Za-z0-9_-]+)$/);
    if (request.method === 'GET' && selectionMatch) {
      const launchId = validateLaunchId(selectionMatch[1]);
      const selection = selectionStore.get(launchId);
      const today = new Date();
      const template = historyStore.getDefaultTemplate();
      const context = await dataSource.getPatientReminderContext(
        selection.patientNumber,
        localIso(today),
        localIso(addDays(today, config.limits.singlePatientLookaheadDays)),
      );
      if (!context) throw new HttpError(404, 'Der übergebene Patient wurde in MEDICAL OFFICE nicht gefunden.');
      json(response, 200, {
        launchId,
        expiresAt: new Date(selection.expiresAt).toISOString(),
        mode: config.sms.mode,
        ...publicPatientContext(context, template?.body || config.sms.template),
      });
      return;
    }

    const cancelMatch = url.pathname.match(/^\/api\/integrations\/medical-office\/selections\/([A-Za-z0-9_-]+)\/cancel$/);
    if (request.method === 'POST' && cancelMatch) {
      requireBrowserPostSecurity(request, csrfToken);
      await readJsonBody(request, config.limits.requestBodyBytes);
      selectionStore.cancel(validateLaunchId(cancelMatch[1]));
      json(response, 200, { status: 'cancelled' });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/reminders/single') {
      requireBrowserPostSecurity(request, csrfToken);
      const body = await readJsonBody(request, config.limits.requestBodyBytes);
      const launchId = validateLaunchId(body.launchId);
      const appointmentId = parsePositiveInt(body.appointmentId, 'Termin-ID');
      const idempotencyKey = validateIdempotencyKey(request.headers['idempotency-key']);
      const selection = selectionStore.get(launchId);
      const today = new Date();
      const from = localIso(today);
      const to = localIso(addDays(today, config.limits.singlePatientLookaheadDays));
      const context = await dataSource.getPatientReminderContext(selection.patientNumber, from, to);
      if (!context?.appointments.some((appointment) => appointment.id === appointmentId && appointmentCanBeReminded(appointment))) {
        throw new ReminderConflictError('Der ausgewählte Termin gehört nicht zu den zulässigen kommenden Terminen.');
      }
      const result = await reminderService.send({
        appointmentIds: [appointmentId],
        expectedPatientNumber: selection.patientNumber,
        idempotencyKey,
        source: 'medical-office-button',
        allowedFrom: from,
        allowedTo: to,
        template: historyStore.getDefaultTemplate()?.body || config.sms.template,
      });
      selectionStore.consume(launchId);
      json(response, 200, result);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/reminder-batches') {
      requireBrowserPostSecurity(request, csrfToken);
      const body = await readJsonBody(request, config.limits.requestBodyBytes);
      if (!Array.isArray(body.appointmentIds) || body.appointmentIds.length < 1 || body.appointmentIds.length > config.limits.maxBatchSize) {
        throw new InputError(`Es müssen 1 bis ${config.limits.maxBatchSize} Termine ausgewählt werden.`);
      }
      const appointmentIds = body.appointmentIds.map((id) => parsePositiveInt(id, 'Termin-ID'));
      const resendAppointmentIds = body.resendAppointmentIds === undefined
        ? []
        : (() => {
          if (!Array.isArray(body.resendAppointmentIds)) {
            throw new InputError('resendAppointmentIds muss eine Liste sein.');
          }
          const parsed = body.resendAppointmentIds.map((id) => parsePositiveInt(id, 'Wiederholungs-Termin-ID'));
          if (new Set(parsed).size !== parsed.length) {
            throw new InputError('Wiederholungs-Termin-IDs dürfen nicht doppelt vorkommen.');
          }
          const selected = new Set(appointmentIds);
          if (parsed.some((id) => !selected.has(id))) {
            throw new InputError('Wiederholungen dürfen nur für ausgewählte Termine freigegeben werden.');
          }
          return parsed;
        })();
      const idempotencyKey = validateIdempotencyKey(request.headers['idempotency-key']);
      const template = templateForRequest(historyStore, body.templateId);
      const today = new Date();
      const result = await reminderService.send({
        appointmentIds,
        resendAppointmentIds,
        idempotencyKey,
        source: 'calendar-selection',
        allowedFrom: localIso(today),
        allowedTo: localIso(addDays(today, config.limits.singlePatientLookaheadDays)),
        template: template.body,
      });
      json(response, 200, result);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      throw new HttpError(404, 'API-Endpunkt nicht gefunden.');
    }
  }

  async function serveStatic(response, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = resolve(root, relative);
    const insidePublicDirectory = file.toLocaleLowerCase().startsWith(`${resolve(root).toLocaleLowerCase()}${sep}`);
    if (!insidePublicDirectory) throw new HttpError(404, 'Nicht gefunden');

    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('Not a file');
      response.writeHead(200, {
        ...securityHeaders,
        'Content-Type': contentTypes.get(extname(file)) || 'application/octet-stream',
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Nicht gefunden');
    }
  }

  return createServer(async (request, response) => {
    try {
      if (!isLoopback(request.socket.remoteAddress) || !hostIsLoopback(request.headers.host)) {
        throw new HttpError(403, 'Die Anwendung ist ausschließlich lokal erreichbar.');
      }
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
      else await serveStatic(response, url.pathname);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const result = publicError(error);
      const body = { error: result.message };
      if (result.details) body.details = result.details;
      json(response, result.status, body);
    }
  });
}
