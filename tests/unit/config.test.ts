import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('config.ts', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('has sensible defaults', async () => {
    delete process.env.TV_CDP_HOST;
    delete process.env.TV_CDP_PORT;
    delete process.env.TV_LOG_LEVEL;

    // Dynamic import to pick up fresh env
    const { config } = await import('../../src/config.js');
    expect(config.CDP_HOST).toBe('127.0.0.1');
    expect(config.CDP_PORT).toBe(9222);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.MAX_RETRIES).toBe(5);
    expect(config.BASE_DELAY_MS).toBe(500);
  });
});
