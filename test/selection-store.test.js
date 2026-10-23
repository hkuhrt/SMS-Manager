import assert from 'node:assert/strict';
import test from 'node:test';
import { SelectionError, SelectionStore } from '../src/selection-store.js';

test('erzeugt kurzlebige Übergaben und fängt Doppelklicks ab', () => {
  let now = 1_000_000;
  const store = new SelectionStore({ ttlSeconds: 300, duplicateWindowSeconds: 30, now: () => now });
  const first = store.create({ patientNumber: 42, sourceModifiedAt: new Date(now).toISOString() });
  now += 5_000;
  const duplicate = store.create({ patientNumber: 42, sourceModifiedAt: new Date(now).toISOString() });
  assert.equal(duplicate.id, first.id);

  store.consume(first.id);
  assert.throws(() => store.get(first.id), SelectionError);
});

test('verwirft abgelaufene Übergaben', () => {
  let now = 1_000_000;
  const store = new SelectionStore({ ttlSeconds: 60, now: () => now });
  const selection = store.create({ patientNumber: 42, sourceModifiedAt: new Date(now).toISOString() });
  now += 61_000;
  assert.throws(() => store.get(selection.id), SelectionError);
});
