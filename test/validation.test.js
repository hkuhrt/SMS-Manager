import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InputError,
  assertSingleSmsFallback,
  inspectSmsFallback,
  maskPhone,
  normalizeMobile,
  parseIsoDate,
  renderNeutralReminder,
  renderReminder,
  validateDateRange,
  validateIdempotencyKey,
} from '../src/validation.js';

test('validiert einen erlaubten Datumsbereich', () => {
  assert.deepEqual(validateDateRange('2026-10-23', '2026-10-30', 31), {
    from: '2026-10-23',
    to: '2026-10-30',
    days: 8,
  });
});

test('verwirft ungültige oder zu große Datumsbereiche', () => {
  assert.throws(() => parseIsoDate('2026-02-30', 'Von'), InputError);
  assert.throws(() => validateDateRange('2026-10-30', '2026-10-23', 31), InputError);
  assert.throws(() => validateDateRange('2026-01-01', '2026-03-01', 31), InputError);
});

test('maskiert Telefonnummern für die Terminliste', () => {
  assert.equal(maskPhone('+49 170 1234567'), '•••• 4567');
  assert.equal(maskPhone(''), null);
});

test('setzt nur freigegebene Platzhalter in SMS-Vorlagen ein', () => {
  const message = renderReminder('Hallo {vorname} {nachname}, Termin {datum} um {uhrzeit}.', {
    firstName: 'Erika',
    lastName: 'Muster',
    date: '2026-10-24',
    time: '09:30:00',
  });
  assert.equal(message, 'Hallo Erika Muster, Termin 2026-10-24 um 09:30.');
});

test('normalisiert deutsche Mobilnummern ohne private Telefon-Fallbacks', () => {
  assert.equal(normalizeMobile('0170 / 123 45 67'), '+491701234567');
  assert.equal(normalizeMobile('0049 170 1234567'), '+491701234567');
  assert.equal(normalizeMobile('abc'), null);
});

test('rendert die neutrale serverseitige Erinnerung', () => {
  assert.equal(renderNeutralReminder(
    'Praxis Recker: Termin am {datum} um {uhrzeit} Uhr.',
    { date: '2026-10-24', time: '09:30:00' },
  ), 'Praxis Recker: Termin am 24.10.2026 um 09:30 Uhr.');
});

test('verlangt eine ausreichend starke Idempotenzkennung', () => {
  assert.equal(validateIdempotencyKey('12345678-abcd'), '12345678-abcd');
  assert.throws(() => validateIdempotencyKey('kurz'), InputError);
});

test('begrenzt den neutralen SMS-Fallback auf ein Segment', () => {
  assert.deepEqual(inspectSmsFallback('Termin {ok}'), {
    encoding: 'GSM-7',
    units: 13,
    limit: 160,
    fitsSingleSms: true,
  });
  assert.throws(() => assertSingleSmsFallback('x'.repeat(161)), InputError);
  assert.throws(() => assertSingleSmsFallback('🙂'.repeat(71)), InputError);
});

