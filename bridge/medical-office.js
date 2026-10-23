import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { readAktPatFile } from '../src/aktpat.js';

async function run() {
  const { patientNumber, sourceModifiedAt } = await readAktPatFile(config.integration.aktPatPath, {
    maxAgeSeconds: config.integration.sourceFreshnessSeconds,
  });
  const integrationKey = (await readFile(config.integration.keyFile, 'utf8')).trim();
  if (!integrationKey) throw new Error('Die lokale Integrationskennung fehlt.');

  const response = await fetch(`http://127.0.0.1:${config.app.port}/api/integrations/medical-office/selections`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MO-Integration-Key': integrationKey,
    },
    body: JSON.stringify({ patientNumber, sourceModifiedAt }),
    signal: AbortSignal.timeout(5_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Die lokale Reminder-App hat die Übergabe abgelehnt.');

  const browser = spawn('explorer.exe', [result.openUrl], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  browser.unref();
}

try {
  await run();
} catch (error) {
  const message = error.cause?.code === 'ECONNREFUSED'
    ? 'Der SMSReminder-Dienst ist nicht erreichbar. Bitte starten Sie die Anwendung und versuchen Sie es erneut.'
    : error.message;
  console.error(`MEDICAL-OFFICE-Übergabe fehlgeschlagen: ${message}`);
  process.exitCode = 1;
}
