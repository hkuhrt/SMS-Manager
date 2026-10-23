import { config } from './config.js';
import { MariaDbDataSource } from './database.js';
import { DemoDataSource } from './demo-data-source.js';
import { FirebirdDataSource } from './firebird-source.js';

export function createDataSource(kind = config.database.kind) {
  let source;
  if (kind === 'mariadb') source = new MariaDbDataSource();
  else if (kind === 'firebird') source = new FirebirdDataSource();
  else throw new Error(`Unbekannte Datenquelle: ${kind}`);

  return config.sms.mode === 'mock' ? new DemoDataSource(source) : source;
}
