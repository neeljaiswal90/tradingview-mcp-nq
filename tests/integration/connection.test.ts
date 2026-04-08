import { describe, it, expect } from 'vitest';
import { discoverTargets } from '../../src/core/cdp/targets.js';

describe('CDP connection — integration (skip if TV not running)', () => {
  it('discoverTargets returns an array (or throws ECONNREFUSED)', async () => {
    try {
      const targets = await discoverTargets();
      expect(Array.isArray(targets)).toBe(true);
    } catch (err) {
      expect((err as Error).message).toMatch(/ECONNREFUSED|fetch failed|network/i);
    }
  });
});
