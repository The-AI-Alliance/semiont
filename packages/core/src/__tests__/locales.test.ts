import { describe, test, expect } from 'vitest';
import {
  getLocaleInfo,
  getLocaleNativeName,
  getLocaleEnglishName,
  formatLocaleDisplay,
} from '../locales';

describe('getLocaleInfo', () => {
  test('returns info for valid code', () => {
    const info = getLocaleInfo('de');
    expect(info?.englishName).toBe('German');
    expect(info?.nativeName).toBe('Deutsch');
  });

  test('is case-insensitive', () => {
    expect(getLocaleInfo('DE')?.englishName).toBe('German');
  });

  test('returns undefined for unknown code', () => {
    expect(getLocaleInfo('xx')).toBeUndefined();
  });

  test('returns undefined for undefined input', () => {
    expect(getLocaleInfo(undefined)).toBeUndefined();
  });
});

describe('getLocaleNativeName', () => {
  test('returns native name', () => {
    expect(getLocaleNativeName('ja')).toBe('日本語');
  });

  test('returns undefined for unknown', () => {
    expect(getLocaleNativeName('xx')).toBeUndefined();
  });

  test('returns undefined for undefined', () => {
    expect(getLocaleNativeName(undefined)).toBeUndefined();
  });
});

describe('getLocaleEnglishName', () => {
  test('returns English name', () => {
    expect(getLocaleEnglishName('fr')).toBe('French');
  });

  test('returns undefined for unknown', () => {
    expect(getLocaleEnglishName('xx')).toBeUndefined();
  });
});

describe('formatLocaleDisplay', () => {
  test('formats as "NativeName (code)"', () => {
    expect(formatLocaleDisplay('es')).toBe('Español (es)');
  });

  test('returns code for unknown locale', () => {
    expect(formatLocaleDisplay('xx')).toBe('xx');
  });

  test('returns undefined for undefined', () => {
    expect(formatLocaleDisplay(undefined)).toBeUndefined();
  });

  test('lowercases the code in output', () => {
    expect(formatLocaleDisplay('FR')).toBe('Français (fr)');
  });
});
