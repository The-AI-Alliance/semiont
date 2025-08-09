/**
 * Simple unit tests for validation schemas
 */

import { describe, it, expect } from 'vitest';
import { 
  GoogleAuthSchema, 
  HelloParamsSchema, 
  EmailSchema, 
  CuidSchema, 
  JWTPayloadSchema,
  validateData
} from '../../validation/schemas';

describe('Validation Schemas Unit Tests', () => {
  describe('GoogleAuthSchema', () => {
    it('should validate valid Google auth request', () => {
      const validRequest = { access_token: 'valid-token-123' };
      const result = GoogleAuthSchema.safeParse(validRequest);
      expect(result.success).toBe(true);
    });

    it('should reject empty access token', () => {
      const invalidRequest = { access_token: '' };
      const result = GoogleAuthSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('should reject missing access token', () => {
      const invalidRequest = {};
      const result = GoogleAuthSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });
  });

  describe('HelloParamsSchema', () => {
    it('should validate valid name parameter', () => {
      const validParams = { name: 'John' };
      const result = HelloParamsSchema.safeParse(validParams);
      expect(result.success).toBe(true);
    });

    it('should accept missing name parameter', () => {
      const emptyParams = {};
      const result = HelloParamsSchema.safeParse(emptyParams);
      expect(result.success).toBe(true);
    });

    it('should reject name that is too long', () => {
      const invalidParams = { name: 'a'.repeat(101) };
      const result = HelloParamsSchema.safeParse(invalidParams);
      expect(result.success).toBe(false);
    });
  });

  describe('EmailSchema', () => {
    it('should validate valid email addresses', () => {
      const validEmails = [
        'user@example.com',
        'test.email@domain.org',
        'admin@company.net'
      ];

      validEmails.forEach(email => {
        const result = EmailSchema.safeParse(email);
        expect(result.success).toBe(true);
      });
    });

    it('should reject invalid email addresses', () => {
      const invalidEmails = [
        'not-an-email',
        '@example.com',
        'user@',
        'user@.com',
        ''
      ];

      invalidEmails.forEach(email => {
        const result = EmailSchema.safeParse(email);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('CuidSchema', () => {
    it('should validate valid CUID', () => {
      const validCuid = 'ckl123456789abcdef';
      const result = CuidSchema.safeParse(validCuid);
      expect(result.success).toBe(true);
    });

    it('should reject invalid CUID', () => {
      const invalidCuids = [
        'invalid-cuid',
        '123',
        '',
        'not-a-cuid-at-all'
      ];

      invalidCuids.forEach(cuid => {
        const result = CuidSchema.safeParse(cuid);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('JWTPayloadSchema', () => {
    const validPayload = {
      userId: 'ckl123456789abcdef',
      email: 'user@example.com',
      name: 'Test User',
      domain: 'example.com',
      provider: 'google',
      isAdmin: false,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days from now
    };

    it('should validate valid JWT payload', () => {
      const result = JWTPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    it('should validate payload without optional name', () => {
      const { name, ...payloadWithoutName } = validPayload;
      const result = JWTPayloadSchema.safeParse(payloadWithoutName);
      expect(result.success).toBe(true);
    });

    it('should reject payload with missing required fields', () => {
      const incompletePayloads = [
        { ...validPayload, userId: undefined },
        { ...validPayload, email: undefined },
        { ...validPayload, domain: undefined },
        { ...validPayload, provider: undefined },
        { ...validPayload, isAdmin: undefined },
        { ...validPayload, iat: undefined },
        { ...validPayload, exp: undefined },
      ];

      incompletePayloads.forEach(payload => {
        const result = JWTPayloadSchema.safeParse(payload);
        expect(result.success).toBe(false);
      });
    });

    it('should reject expired token', () => {
      const expiredPayload = {
        ...validPayload,
        exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
      };
      const result = JWTPayloadSchema.safeParse(expiredPayload);
      expect(result.success).toBe(false);
    });

    it('should reject payload where exp is before iat', () => {
      const invalidPayload = {
        ...validPayload,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) - 1000, // before iat
      };
      const result = JWTPayloadSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
    });
  });

  describe('validateData helper function', () => {
    it('should return success for valid data', () => {
      const validData = { name: 'John' };
      const result = validateData(HelloParamsSchema, validData);
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validData);
      }
    });

    it('should return error for invalid data', () => {
      // Test with an invalid type (number instead of string)
      const invalidData = { name: 123 as any };
      const result = validateData(HelloParamsSchema, invalidData);
      
      expect(result.success).toBe(false);
      if (!result.success) {
        // The error should be a string indicating validation failure
        expect(result.error).toBeTruthy();
        expect(typeof result.error).toBe('string');
      }
    });

    it('should handle non-Zod errors', () => {
      // Create a schema that throws a non-Zod error
      const mockSchema = {
        parse: () => {
          throw new Error('Custom error');
        }
      } as any;

      const result = validateData(mockSchema, {});
      
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Validation failed');
      }
    });
  });
});