import { randomBytes } from 'node:crypto';

export class SelectionError extends Error {
  constructor(message, status = 410) {
    super(message);
    this.name = 'SelectionError';
    this.status = status;
  }
}

export class SelectionStore {
  constructor({ ttlSeconds = 300, duplicateWindowSeconds = 30, now = () => Date.now() } = {}) {
    this.ttlMs = ttlSeconds * 1_000;
    this.duplicateWindowMs = duplicateWindowSeconds * 1_000;
    this.now = now;
    this.selections = new Map();
  }

  create({ patientNumber, sourceModifiedAt }) {
    this.purge();
    const createdAt = this.now();
    for (const existing of this.selections.values()) {
      if (!existing.consumed
        && existing.patientNumber === patientNumber
        && createdAt - existing.createdAt <= this.duplicateWindowMs) {
        return existing;
      }
    }

    const selection = {
      id: randomBytes(24).toString('base64url'),
      patientNumber,
      sourceModifiedAt,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      consumed: false,
    };
    this.selections.set(selection.id, selection);
    return selection;
  }

  get(id) {
    const selection = this.selections.get(id);
    if (!selection || selection.expiresAt <= this.now()) {
      if (selection) this.selections.delete(id);
      throw new SelectionError('Diese Patientenübergabe ist abgelaufen. Bitte den Button in MEDICAL OFFICE erneut drücken.');
    }
    if (selection.consumed) {
      throw new SelectionError('Diese Patientenübergabe wurde bereits abgeschlossen.');
    }
    return selection;
  }

  consume(id) {
    const selection = this.get(id);
    selection.consumed = true;
    return selection;
  }

  cancel(id) {
    return this.consume(id);
  }

  purge() {
    const now = this.now();
    for (const [id, selection] of this.selections) {
      if (selection.expiresAt <= now || selection.consumed) this.selections.delete(id);
    }
  }
}
