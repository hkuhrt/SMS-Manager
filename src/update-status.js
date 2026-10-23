import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8'));
const states = new Set(['current', 'updated', 'blocked', 'failed', 'never-checked']);
const versionPattern = /^\d+\.\d+\.\d+$/;

export const APP_VERSION = versionPattern.test(packageMetadata.version)
  ? packageMetadata.version
  : '0.0.0';

function safeVersion(value) {
  return typeof value === 'string' && versionPattern.test(value) ? value : null;
}

function safeDate(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function safeMessage(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return sanitized.slice(0, 240) || fallback;
}

export function defaultUpdateStatus(appVersion = APP_VERSION) {
  return {
    currentVersion: appVersion,
    latestVersion: null,
    state: 'never-checked',
    checkedAt: null,
    installedAt: null,
    message: 'Es wurde noch nicht nach Updates gesucht.',
  };
}

export function normalizeUpdateStatus(value, appVersion = APP_VERSION) {
  const fallback = defaultUpdateStatus(appVersion);
  if (!value || Array.isArray(value) || typeof value !== 'object') return fallback;
  return {
    currentVersion: appVersion,
    latestVersion: safeVersion(value.latestVersion),
    state: states.has(value.state) ? value.state : fallback.state,
    checkedAt: safeDate(value.checkedAt),
    installedAt: safeDate(value.installedAt),
    message: safeMessage(value.message, fallback.message),
  };
}

export function createUpdateStatusReader({ dataDirectory, appVersion = APP_VERSION }) {
  const statusPath = join(dataDirectory, 'update-status.json');
  return async function readUpdateStatus() {
    try {
      const raw = await readFile(statusPath, 'utf8');
      return normalizeUpdateStatus(JSON.parse(raw.replace(/^\uFEFF/, '')), appVersion);
    } catch (error) {
      if (error.code === 'ENOENT') return defaultUpdateStatus(appVersion);
      return {
        ...defaultUpdateStatus(appVersion),
        state: 'failed',
        message: 'Der lokale Update-Status konnte nicht gelesen werden.',
      };
    }
  };
}
