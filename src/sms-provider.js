import { randomUUID } from 'node:crypto';

export class MockSmsProvider {
  mode = 'mock';

  async send() {
    return {
      status: 'simulated',
      providerReference: `mock_${randomUUID()}`,
    };
  }
}

export function createSmsProvider(mode) {
  if (mode !== 'mock') {
    throw new Error('Ein echter SMS-Anbieter ist noch nicht eingerichtet.');
  }
  return new MockSmsProvider();
}
