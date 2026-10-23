const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const GSM_BASIC = new Set([
  ...'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ',
  ...' !"#¤%&\'()*+,-./0123456789:;<=>?',
  ...'¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
]);
const GSM_EXTENSION = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€']);

export function parseIsoDate(value, fieldName) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new InputError(`${fieldName} muss das Format JJJJ-MM-TT haben.`);
  }

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new InputError(`${fieldName} ist kein gültiges Datum.`);
  }
  return date;
}

export function validateDateRange(fromValue, toValue, maxDays) {
  const from = parseIsoDate(fromValue, 'Von');
  const to = parseIsoDate(toValue, 'Bis');
  const days = Math.floor((to - from) / 86_400_000) + 1;

  if (days < 1) throw new InputError('Das Bis-Datum darf nicht vor dem Von-Datum liegen.');
  if (days > maxDays) throw new InputError(`Der Zeitraum darf höchstens ${maxDays} Tage umfassen.`);

  return { from: fromValue, to: toValue, days };
}

export function parseOptionalPositiveInt(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  if (!/^\d+$/.test(String(value))) throw new InputError(`${fieldName} ist ungültig.`);

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new InputError(`${fieldName} ist ungültig.`);
  return parsed;
}

export function parsePositiveInt(value, fieldName) {
  const parsed = parseOptionalPositiveInt(value, fieldName);
  if (parsed === null) throw new InputError(`${fieldName} fehlt.`);
  return parsed;
}

export function parsePatientNumber(value) {
  return parsePositiveInt(value, 'Patientennummer');
}

export function validateLaunchId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new InputError('Die Patientenübergabe ist ungültig. Bitte den Button in MEDICAL OFFICE erneut drücken.');
  }
  return value;
}

export function validateIdempotencyKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new InputError('Die Vorgangskennung fehlt oder ist ungültig.');
  }
  return value;
}

export function normalizeMobile(value) {
  if (!value) return null;
  let normalized = String(value).trim().replace(/[\s()/.-]/g, '');
  if (normalized.startsWith('00')) normalized = `+${normalized.slice(2)}`;
  else if (normalized.startsWith('0')) normalized = `+49${normalized.slice(1)}`;

  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) return null;
  return normalized;
}

export function maskPhone(value) {
  if (!value) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  const digits = normalized.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length <= 4) return `•••${digits.slice(-1)}`;
  return `•••• ${digits.slice(-4)}`;
}

export function renderReminder(template, appointment) {
  const replacements = {
    anrede: appointment.salutation || '',
    vorname: appointment.firstName || '',
    nachname: appointment.lastName || '',
    datum: appointment.date || '',
    uhrzeit: appointment.time?.slice(0, 5) || '',
  };

  return template
    .replace(/\{(anrede|vorname|nachname|datum|uhrzeit)\}/g, (_, key) => replacements[key])
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function renderNeutralReminder(template, appointment) {
  const date = parseIsoDate(appointment.date, 'Termindatum');
  const formattedDate = new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
  const time = typeof appointment.time === 'string' && /^\d{2}:\d{2}/.test(appointment.time)
    ? appointment.time.slice(0, 5)
    : '';
  if (!time) throw new InputError('Der ausgewählte Termin hat keine gültige Uhrzeit.');

  return template
    .replaceAll('{datum}', formattedDate)
    .replaceAll('{uhrzeit}', time)
    .trim();
}

export function inspectSmsFallback(message) {
  let units = 0;
  let encoding = 'GSM-7';
  for (const character of message) {
    if (GSM_BASIC.has(character)) units += 1;
    else if (GSM_EXTENSION.has(character)) units += 2;
    else {
      encoding = 'UCS-2';
      units = [...message].length;
      break;
    }
  }
  const limit = encoding === 'GSM-7' ? 160 : 70;
  return { encoding, units, limit, fitsSingleSms: units <= limit };
}

export function assertSingleSmsFallback(message) {
  const result = inspectSmsFallback(message);
  if (!result.fitsSingleSms) {
    throw new InputError(
      `Der Text benötigt ${result.units} ${result.encoding === 'GSM-7' ? 'Zeicheneinheiten' : 'Unicode-Zeichen'}; `
      + `für den SMS-Fallback sind höchstens ${result.limit} erlaubt.`,
    );
  }
  return result;
}

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

