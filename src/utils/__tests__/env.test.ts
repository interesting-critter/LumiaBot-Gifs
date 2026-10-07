import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { boolEnv, floatEnv, hexColorEnv, intEnv, strEnv } from '../env';

/**
 * These helpers exist because a bare `parseInt(process.env.X || '')` yields NaN
 * for junk input, and every comparison against NaN is false — so a NaN limit
 * silently disables the very cap it was written to enforce. These tests pin that
 * behaviour down.
 */

const KEY = 'BUNNY_TEST_ENV_VAR';
let original: string | undefined;

beforeEach(() => {
  original = process.env[KEY];
});

afterEach(() => {
  if (original === undefined) {
    delete process.env[KEY];
  } else {
    process.env[KEY] = original;
  }
});

function set(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[KEY];
  } else {
    process.env[KEY] = value;
  }
}

describe('intEnv', () => {
  test('returns the fallback when the variable is missing', () => {
    set(undefined);
    expect(intEnv(KEY, 7)).toBe(7);
  });

  test('returns the fallback when the variable is empty or whitespace-only', () => {
    set('');
    expect(intEnv(KEY, 7)).toBe(7);
    set('   ');
    expect(intEnv(KEY, 7)).toBe(7);
    set('\t\n ');
    expect(intEnv(KEY, 7)).toBe(7);
  });

  test('returns the fallback for unparseable input instead of NaN', () => {
    set('abc');
    expect(intEnv(KEY, 7)).toBe(7);
    set('12abc');
    expect(intEnv(KEY, 7)).toBe(12);
  });

  test('keeps a legitimate zero rather than treating it as missing', () => {
    set('0');
    expect(intEnv(KEY, 7)).toBe(0);
  });

  test('parses negatives', () => {
    set('-5');
    expect(intEnv(KEY, 7)).toBe(-5);
  });

  test('clamps at min and max', () => {
    set('10');
    expect(intEnv(KEY, 7, { min: 1, max: 20 })).toBe(10);
    set('-100');
    expect(intEnv(KEY, 7, { min: 1, max: 20 })).toBe(1);
    set('9999');
    expect(intEnv(KEY, 7, { min: 1, max: 20 })).toBe(20);
  });

  test('clamps the fallback too', () => {
    set(undefined);
    expect(intEnv(KEY, 0, { min: 1 })).toBe(1);
  });

  test('trims surrounding whitespace', () => {
    set('  12  ');
    expect(intEnv(KEY, 7)).toBe(12);
  });
});

describe('floatEnv', () => {
  test('keeps decimals', () => {
    set('0.25');
    expect(floatEnv(KEY, 1)).toBe(0.25);
  });

  test('returns the fallback when missing, blank or unparseable', () => {
    set(undefined);
    expect(floatEnv(KEY, 1.5)).toBe(1.5);
    set('');
    expect(floatEnv(KEY, 1.5)).toBe(1.5);
    set('  ');
    expect(floatEnv(KEY, 1.5)).toBe(1.5);
    set('abc');
    expect(floatEnv(KEY, 1.5)).toBe(1.5);
  });

  test('rejects non-finite values', () => {
    set('Infinity');
    expect(floatEnv(KEY, 1.5)).toBe(1.5);
    set('-Infinity');
    expect(floatEnv(KEY, 1.5)).toBe(1.5);
    set('NaN');
    expect(floatEnv(KEY, 1.5)).toBe(1.5);
  });

  test('parses negatives and clamps them into range', () => {
    set('-3.5');
    expect(floatEnv(KEY, 1.5)).toBe(-3.5);
    expect(floatEnv(KEY, 1.5, { min: 0, max: 2 })).toBe(0);
    set('9.5');
    expect(floatEnv(KEY, 1.5, { min: 0, max: 2 })).toBe(2);
  });
});

describe('boolEnv', () => {
  test('defaults when missing or blank', () => {
    set(undefined);
    expect(boolEnv(KEY, true)).toBe(true);
    expect(boolEnv(KEY, false)).toBe(false);
    set('   ');
    expect(boolEnv(KEY, false)).toBe(false);
  });

  test('accepts every truthy spelling, case-insensitively', () => {
    for (const value of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON']) {
      set(value);
      expect(boolEnv(KEY, false)).toBe(true);
    }
  });

  test('accepts every falsy spelling, case-insensitively', () => {
    for (const value of ['0', 'false', 'FALSE', 'False', 'no', 'NO', 'off', 'OFF']) {
      set(value);
      expect(boolEnv(KEY, true)).toBe(false);
    }
  });

  test('returns the fallback for anything else', () => {
    set('ture');
    expect(boolEnv(KEY, false)).toBe(false);
    set('ture');
    expect(boolEnv(KEY, true)).toBe(true);
    set('2');
    expect(boolEnv(KEY, false)).toBe(false);
  });
});

describe('hexColorEnv', () => {
  test('returns the fallback when the variable is missing or blank', () => {
    set(undefined);
    expect(hexColorEnv(KEY, 0x9f3c41)).toBe(0x9f3c41);
    set('  ');
    expect(hexColorEnv(KEY, 0x9f3c41)).toBe(0x9f3c41);
  });

  test('accepts #RRGGBB, bare RRGGBB and 0xRRGGBB', () => {
    set('#9F3C41');
    expect(hexColorEnv(KEY, 0)).toBe(0x9f3c41);
    set('9F3C41');
    expect(hexColorEnv(KEY, 0)).toBe(0x9f3c41);
    set('0x9F3C41');
    expect(hexColorEnv(KEY, 0)).toBe(0x9f3c41);
    set('  #ffffff  ');
    expect(hexColorEnv(KEY, 0)).toBe(0xffffff);
  });

  test('falls back and warns for anything that is not 24-bit hex', () => {
    // A 3-digit form is rejected rather than expanded: `FFF` is ambiguous with
    // the CSS shorthand, and guessing would produce a silently wrong colour.
    for (const bad of ['fff', '#FFF', 'red', '#9F3C4', '#9F3C411', '0xZZZZZZ', '#GGGGGG']) {
      const warnings: string[] = [];
      set(bad);
      expect(hexColorEnv(KEY, 0x9f3c41, (m) => warnings.push(m))).toBe(0x9f3c41);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(KEY);
    }
  });
});

describe('strEnv', () => {
  test('returns the fallback when missing, empty or whitespace-only', () => {
    set(undefined);
    expect(strEnv(KEY, 'fallback')).toBe('fallback');
    set('');
    expect(strEnv(KEY, 'fallback')).toBe('fallback');
    set('   ');
    expect(strEnv(KEY, 'fallback')).toBe('fallback');
  });

  test('returns the trimmed value when set', () => {
    set('  value  ');
    expect(strEnv(KEY, 'fallback')).toBe('value');
    set('');
    expect(strEnv(KEY, 'fallback')).toBe('fallback');
  });
});
