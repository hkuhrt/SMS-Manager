import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function loadOrCreateIntegrationKey(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    return (await readFile(filePath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const generated = randomBytes(32).toString('base64url');
  try {
    await writeFile(filePath, `${generated}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return (await readFile(filePath, 'utf8')).trim();
  }
}

export function integrationKeyMatches(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length
    && timingSafeEqual(expectedBuffer, receivedBuffer);
}
