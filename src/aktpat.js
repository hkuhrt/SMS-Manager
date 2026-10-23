import { readFile, stat } from 'node:fs/promises';
import { InputError, parsePatientNumber } from './validation.js';

export function parseAktPat(content) {
  let buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    buffer = buffer.subarray(3);
  }

  const firstLine = buffer.toString('latin1').split(/\r?\n/, 1)[0].trim();
  if (!/^\d{1,10}$/.test(firstLine)) {
    throw new InputError('AKTPAT.TXT enthält keine gültige Patientennummer.');
  }
  return parsePatientNumber(firstLine);
}

export function assertFreshSourceTimestamp(sourceModifiedAt, {
  now = Date.now(),
  maxAgeSeconds = 30,
} = {}) {
  const modifiedAt = new Date(sourceModifiedAt);
  if (Number.isNaN(modifiedAt.valueOf())) {
    throw new InputError('Der Änderungszeitpunkt von AKTPAT.TXT ist ungültig.');
  }

  const ageMs = now - modifiedAt.valueOf();
  if (ageMs < -5_000 || ageMs > maxAgeSeconds * 1_000) {
    throw new InputError('AKTPAT.TXT ist veraltet. Bitte den Button in MEDICAL OFFICE erneut drücken.');
  }
  return modifiedAt.toISOString();
}

export async function readAktPatFile(filePath, options = {}) {
  const [content, info] = await Promise.all([readFile(filePath), stat(filePath)]);
  const sourceModifiedAt = assertFreshSourceTimestamp(info.mtime, options);
  return {
    patientNumber: parseAktPat(content),
    sourceModifiedAt,
  };
}
