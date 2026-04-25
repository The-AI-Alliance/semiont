import { describe, test, expect } from 'vitest';
import { JWTTokenSchema, validateData, isValidEmail } from '../validation';

describe('JWTTokenSchema', () => {
  describe('parse', () => {
    test('accepts valid JWT format', () => {
      const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123';
      expect(JWTTokenSchema.parse(token)).toBe(token);
    });

    test('rejects non-string', () => {
      expect(() => JWTTokenSchema.parse(123)).toThrow('Token must be a string');
    });

    test('rejects empty string', () => {
      expect(() => JWTTokenSchema.parse('')).toThrow('Token is required');
    });

    test('rejects invalid format (no dots)', () => {
      expect(() => JWTTokenSchema.parse('not-a-jwt')).toThrow('Invalid JWT token format');
    });

    test('rejects format with only one dot', () => {
      expect(() => JWTTokenSchema.parse('header.payload')).toThrow('Invalid JWT token format');
    });

    test('accepts token with empty signature', () => {
      // JWTs can have empty signature (unsecured JWTs)
      expect(JWTTokenSchema.parse('header.payload.')).toBe('header.payload.');
    });
  });

  describe('safeParse', () => {
    test('returns success for valid token', () => {
      const result = JWTTokenSchema.safeParse('a.b.c');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('a.b.c');
      }
    });

    test('returns failure for invalid token', () => {
      const result = JWTTokenSchema.safeParse('invalid');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Invalid JWT token format');
      }
    });

    test('returns failure for non-string', () => {
      const result = JWTTokenSchema.safeParse(null);
      expect(result.success).toBe(false);
    });
  });
});

describe('validateData', () => {
  test('returns success when parse succeeds', () => {
    const schema = { parse: (data: unknown) => String(data) };
    const result = validateData(schema, 'hello');
    expect(result).toEqual({ success: true, data: 'hello' });
  });

  test('returns failure when parse throws Error', () => {
    const schema = { parse: () => { throw new Error('bad input'); } };
    const result = validateData(schema, 'anything');
    expect(result).toEqual({ success: false, error: 'bad input' });
  });

  test('returns generic message for non-Error throw', () => {
    const schema = { parse: () => { throw 'string error'; } };
    const result = validateData(schema, 'anything');
    expect(result).toEqual({ success: false, error: 'Validation failed' });
  });
});

describe('isValidEmail', () => {
  test('accepts valid emails', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('user+tag@domain.org')).toBe(true);
  });

  test('rejects empty string', () => {
    expect(isValidEmail('')).toBe(false);
  });

  test('rejects too long', () => {
    expect(isValidEmail('a'.repeat(250) + '@b.com')).toBe(false);
  });

  test('rejects missing @', () => {
    expect(isValidEmail('userexample.com')).toBe(false);
  });

  test('rejects missing domain dot', () => {
    expect(isValidEmail('user@example')).toBe(false);
  });

  test('rejects spaces', () => {
    expect(isValidEmail('user @example.com')).toBe(false);
  });
});
