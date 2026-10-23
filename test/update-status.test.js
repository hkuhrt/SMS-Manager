import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createUpdateStatusReader,
  defaultUpdateStatus,
  normalizeUpdateStatus,
} from '../src/update-status.js';

test('liefert ohne Statusdatei einen neutralen Versionsstatus', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sms-update-status-'));
  try {
    const readStatus = createUpdateStatusReader({ dataDirectory: directory, appVersion: '1.2.3' });
    assert.deepEqual(await readStatus(), defaultUpdateStatus('1.2.3'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bereinigt Update-Status und verwendet immer die laufende App-Version', () => {
  const status = normalizeUpdateStatus({
    currentVersion: '9.9.9',
    latestVersion: '1.3.0',
    state: 'blocked',
    checkedAt: '2026-10-23T20:00:00+02:00',
    installedAt: 'ungültig',
    message: 'Lokale\nÄnderungen\u0000gefunden',
  }, '1.2.3');
  assert.equal(status.currentVersion, '1.2.3');
  assert.equal(status.latestVersion, '1.3.0');
  assert.equal(status.state, 'blocked');
  assert.equal(status.checkedAt, '2026-10-23T18:00:00.000Z');
  assert.equal(status.installedAt, null);
  assert.equal(status.message, 'Lokale Änderungen gefunden');
});

test('meldet eine beschädigte Statusdatei ohne interne Details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sms-update-status-'));
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'update-status.json'), '{kaputt', 'utf8');
    const readStatus = createUpdateStatusReader({ dataDirectory: directory, appVersion: '1.2.3' });
    const status = await readStatus();
    assert.equal(status.state, 'failed');
    assert.equal(status.currentVersion, '1.2.3');
    assert.equal(status.message, 'Der lokale Update-Status konnte nicht gelesen werden.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
