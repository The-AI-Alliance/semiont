import { describe, it, expect } from 'vitest';
import {
  isString,
  isNumber,
  isObject,
  isArray,
  isReportedJobResult,
  isMarkJobResult,
  isYieldJobResult,
} from '../type-guards';
import { resourceId } from '../identifiers';

describe('@semiont/core - type-guards', () => {
  describe('isString', () => {
    it('should return true for strings', () => {
      expect(isString('')).toBe(true);
      expect(isString('hello')).toBe(true);
      expect(isString('123')).toBe(true);
    });

    it('should return false for non-strings', () => {
      expect(isString(123)).toBe(false);
      expect(isString(true)).toBe(false);
      expect(isString(null)).toBe(false);
      expect(isString(undefined)).toBe(false);
      expect(isString({})).toBe(false);
      expect(isString([])).toBe(false);
    });
  });

  describe('isNumber', () => {
    it('should return true for valid numbers', () => {
      expect(isNumber(0)).toBe(true);
      expect(isNumber(42)).toBe(true);
      expect(isNumber(-10)).toBe(true);
      expect(isNumber(3.14)).toBe(true);
      expect(isNumber(Infinity)).toBe(true);
    });

    it('should return false for NaN', () => {
      expect(isNumber(NaN)).toBe(false);
    });

    it('should return false for non-numbers', () => {
      expect(isNumber('123')).toBe(false);
      expect(isNumber(true)).toBe(false);
      expect(isNumber(null)).toBe(false);
      expect(isNumber(undefined)).toBe(false);
      expect(isNumber({})).toBe(false);
    });
  });

  describe('isObject', () => {
    it('should return true for plain objects', () => {
      expect(isObject({})).toBe(true);
      expect(isObject({ key: 'value' })).toBe(true);
      expect(isObject({ nested: { obj: true } })).toBe(true);
    });

    it('should return false for null', () => {
      expect(isObject(null)).toBe(false);
    });

    it('should return false for arrays', () => {
      expect(isObject([])).toBe(false);
      expect(isObject([1, 2, 3])).toBe(false);
    });

    it('should return false for primitives', () => {
      expect(isObject('string')).toBe(false);
      expect(isObject(123)).toBe(false);
      expect(isObject(true)).toBe(false);
      expect(isObject(undefined)).toBe(false);
    });
  });

  describe('isArray', () => {
    it('should return true for arrays', () => {
      expect(isArray([])).toBe(true);
      expect(isArray([1, 2, 3])).toBe(true);
      expect(isArray(['a', 'b'])).toBe(true);
      expect(isArray([{ key: 'value' }])).toBe(true);
    });

    it('should return false for non-arrays', () => {
      expect(isArray({})).toBe(false);
      expect(isArray('string')).toBe(false);
      expect(isArray(123)).toBe(false);
      expect(isArray(null)).toBe(false);
      expect(isArray(undefined)).toBe(false);
    });
  });
});

describe('isReportedJobResult', () => {
  it('accepts a result its worker reported', () => {
    expect(isReportedJobResult({ found: 1, persisted: 1 })).toBe(true);
  });

  it('refuses the empty result a job completed without one is stored with, and an absent one', () => {
    expect(isReportedJobResult({})).toBe(false);
    expect(isReportedJobResult(undefined)).toBe(false);
  });
});

describe('isMarkJobResult and isYieldJobResult', () => {
  const counts = { found: 3, persisted: 2 };
  const made = { resourceId: resourceId('res-new'), resourceName: 'New', truncated: false };
  const decline = { declined: true as const, reason: 'empty' as const };

  it('a mark job reports its counts or a decline, and never the resource a yield job makes', () => {
    expect(isMarkJobResult(counts)).toBe(true);
    expect(isMarkJobResult(decline)).toBe(true);
    expect(isMarkJobResult(made)).toBe(false);
  });

  it('a yield job reports the resource it made or a decline, and never a mark job\'s counts', () => {
    expect(isYieldJobResult(made)).toBe(true);
    expect(isYieldJobResult(decline)).toBe(true);
    expect(isYieldJobResult(counts)).toBe(false);
  });
});
