import { describe, it, expect } from 'vitest';
import { analyze } from '../../src/core/tradingview/pine.js';

describe('pine analyze — static analysis', () => {
  it('clean v6 script — no issues', () => {
    const result = analyze({
      source: `//@version=6
indicator("Test", overlay=true)
a = array.from(1, 2, 3)
val = array.get(a, 1)
plot(close)`,
    });
    expect(result.issue_count).toBe(0);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('array.get out of bounds', () => {
    const result = analyze({
      source: `//@version=6
indicator("Test")
a = array.from(1, 2, 3)
val = array.get(a, 5)`,
    });
    expect(result.issue_count).toBe(1);
    expect(result.diagnostics[0]!.severity).toBe('error');
    expect(result.diagnostics[0]!.message).toContain('out of bounds');
    expect(result.diagnostics[0]!.message).toContain('index 5');
    expect(result.diagnostics[0]!.message).toContain('size is 3');
  });

  it('array.get negative index', () => {
    const result = analyze({
      source: `//@version=6
indicator("Test")
a = array.from(1, 2)
val = array.get(a, -1)`,
    });
    expect(result.issue_count).toBe(1);
    expect(result.diagnostics[0]!.severity).toBe('error');
  });

  it('array.set out of bounds', () => {
    const result = analyze({
      source: `//@version=6
indicator("Test")
a = array.new_float(3)
array.set(a, 10, 99.0)`,
    });
    expect(result.issue_count).toBe(1);
    expect(result.diagnostics[0]!.message).toContain('array.set');
  });

  it('array.get valid index — no issue', () => {
    const result = analyze({
      source: `//@version=6
indicator("Test")
a = array.from(10, 20, 30, 40, 50)
val = array.get(a, 4)`,
    });
    expect(result.issue_count).toBe(0);
  });

  it('.first() on empty array', () => {
    const result = analyze({
      source: `//@version=6
indicator("Test")
a = array.new_float(0)
x = a.first()`,
    });
    expect(result.issue_count).toBe(1);
    expect(result.diagnostics[0]!.severity).toBe('warning');
    expect(result.diagnostics[0]!.message).toContain('empty array');
  });

  it('.last() on empty array', () => {
    const result = analyze({
      source: `//@version=6
indicator("Test")
a = array.new_float(0)
x = a.last()`,
    });
    expect(result.issue_count).toBe(1);
    expect(result.diagnostics[0]!.severity).toBe('warning');
  });

  it('.first() on non-empty array — no issue', () => {
    const result = analyze({
      source: `//@version=6
indicator("Test")
a = array.from(1, 2, 3)
x = a.first()`,
    });
    expect(result.issue_count).toBe(0);
  });

  it('strategy.entry without strategy() declaration', () => {
    const result = analyze({
      source: `//@version=6
indicator("Test")
strategy.entry("Long", strategy.long)`,
    });
    expect(result.issue_count).toBe(1);
    expect(result.diagnostics[0]!.severity).toBe('error');
    expect(result.diagnostics[0]!.message).toContain('no strategy() declaration');
  });

  it('strategy.entry WITH strategy() — no issue', () => {
    const result = analyze({
      source: `//@version=6
strategy("Test", overlay=true)
if close > open
    strategy.entry("Long", strategy.long)`,
    });
    expect(result.issue_count).toBe(0);
  });

  it('old version v3 warning', () => {
    const result = analyze({
      source: `//@version=3
study("Test")
plot(close)`,
    });
    expect(result.issue_count).toBe(1);
    expect(result.diagnostics[0]!.severity).toBe('info');
    expect(result.diagnostics[0]!.message).toContain('v3');
  });

  it('v5 — no version warning', () => {
    const result = analyze({
      source: `//@version=5
indicator("Test")
plot(close)`,
    });
    expect(result.issue_count).toBe(0);
  });

  it('multiple issues at once', () => {
    const result = analyze({
      source: `//@version=6
indicator("Test")
a = array.from(1, 2)
b = array.new_float(0)
x = array.get(a, 5)
y = b.first()
strategy.entry("Long", strategy.long)`,
    });
    expect(result.issue_count).toBeGreaterThanOrEqual(3);
    const errors = result.diagnostics.filter(d => d.severity === 'error');
    const warnings = result.diagnostics.filter(d => d.severity === 'warning');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});
