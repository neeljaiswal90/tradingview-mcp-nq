import { describe, it, expect } from 'vitest';
import { ok, fail, unwrap, isOk, isFail } from '../../src/result.js';

describe('result.ts', () => {
  describe('ok()', () => {
    it('creates a successful result', () => {
      const r = ok(42);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toBe(42);
    });

    it('works with objects', () => {
      const r = ok({ foo: 'bar' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.foo).toBe('bar');
    });
  });

  describe('fail()', () => {
    it('creates a failure result', () => {
      const r = fail('ERR', 'something broke');
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.code).toBe('ERR');
        expect(r.error.message).toBe('something broke');
      }
    });

    it('includes optional hint and details', () => {
      const r = fail('ERR', 'msg', 'try this', { extra: 1 });
      if (!r.success) {
        expect(r.error.hint).toBe('try this');
        expect(r.error.details).toEqual({ extra: 1 });
      }
    });
  });

  describe('unwrap()', () => {
    it('returns data from ok result', () => {
      expect(unwrap(ok(99))).toBe(99);
    });

    it('throws from fail result', () => {
      expect(() => unwrap(fail('ERR', 'bad'))).toThrow('ERR: bad');
    });
  });

  describe('isOk() / isFail()', () => {
    it('identifies ok results', () => {
      expect(isOk(ok(1))).toBe(true);
      expect(isFail(ok(1))).toBe(false);
    });

    it('identifies fail results', () => {
      expect(isOk(fail('E', 'm'))).toBe(false);
      expect(isFail(fail('E', 'm'))).toBe(true);
    });
  });
});
