import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFreshSourceTimestamp, parseAktPat } from '../src/aktpat.js';
import { InputError } from '../src/validation.js';

test('liest ausschließlich die Patientennummer aus der ersten AKTPAT-Zeile', () => {
  assert.equal(parseAktPat(Buffer.from('4711\r\nMuster\r\nErika', 'latin1')), 4711);
  assert.equal(parseAktPat(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('123\r\nName')])), 123);
});

test('verwirft leere oder manipulierte Patientennummern', () => {
  assert.throws(() => parseAktPat(''), InputError);
  assert.throws(() => parseAktPat('12 & calc.exe\r\n'), InputError);
  assert.throws(() => parseAktPat('../123\r\n'), InputError);
});

test('akzeptiert nur eine frische AKTPAT-Datei', () => {
  const now = Date.parse('2026-10-23T12:00:00.000Z');
  assert.equal(
    assertFreshSourceTimestamp('2026-10-23T11:59:45.000Z', { now, maxAgeSeconds: 30 }),
    '2026-10-23T11:59:45.000Z',
  );
  assert.throws(
    () => assertFreshSourceTimestamp('2026-10-23T11:58:00.000Z', { now, maxAgeSeconds: 30 }),
    InputError,
  );
});
