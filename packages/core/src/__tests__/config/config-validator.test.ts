import { describe, it, expect } from 'vitest';
import {
  formatErrors,
  validateSemiontConfig,
  validateEnvironmentConfig,
  validateSiteConfig,
} from '../../config/config-validator';
import type { ErrorObject } from 'ajv';

describe('@semiont/core - config-validator', () => {
  describe('formatErrors', () => {
    it('should format required property errors', () => {
      const errors: ErrorObject[] = [
        {
          keyword: 'required',
          instancePath: '',
          schemaPath: '#/required',
          params: { missingProperty: 'name' },
          message: 'must have required property name',
        } as ErrorObject,
      ];

      const result = formatErrors(errors);
      expect(result).toBe('Missing required property: name');
    });

    it('should format type errors', () => {
      const errors: ErrorObject[] = [
        {
          keyword: 'type',
          instancePath: '/port',
          schemaPath: '#/properties/port/type',
          params: { type: 'number' },
          message: 'must be number',
        } as ErrorObject,
      ];

      const result = formatErrors(errors);
      expect(result).toBe('/port: must be number (expected number)');
    });

    it('should format enum errors', () => {
      const errors: ErrorObject[] = [
        {
          keyword: 'enum',
          instancePath: '/env/NODE_ENV',
          schemaPath: '#/properties/env/properties/NODE_ENV/enum',
          params: { allowedValues: ['development', 'production', 'test'] },
          message: 'must be equal to one of the allowed values',
        } as ErrorObject,
      ];

      const result = formatErrors(errors);
      expect(result).toBe('/env/NODE_ENV: must be one of [development, production, test]');
    });

    it('should format format errors', () => {
      const errors: ErrorObject[] = [
        {
          keyword: 'format',
          instancePath: '/email',
          schemaPath: '#/properties/email/format',
          params: { format: 'email' },
          message: 'must match format "email"',
        } as ErrorObject,
      ];

      const result = formatErrors(errors);
      expect(result).toBe('/email: invalid format (must match format "email")');
    });

    it('should format minLength errors', () => {
      const errors: ErrorObject[] = [
        {
          keyword: 'minLength',
          instancePath: '/name',
          schemaPath: '#/properties/name/minLength',
          params: { limit: 3 },
          message: 'must NOT have fewer than 3 characters',
        } as ErrorObject,
      ];

      const result = formatErrors(errors);
      expect(result).toBe('/name: must NOT have fewer than 3 characters');
    });

    it('should format minItems errors', () => {
      const errors: ErrorObject[] = [
        {
          keyword: 'minItems',
          instancePath: '/tags',
          schemaPath: '#/properties/tags/minItems',
          params: { limit: 1 },
          message: 'must NOT have fewer than 1 items',
        } as ErrorObject,
      ];

      const result = formatErrors(errors);
      expect(result).toBe('/tags: must NOT have fewer than 1 items');
    });

    it('should format multiple errors', () => {
      const errors: ErrorObject[] = [
        {
          keyword: 'required',
          instancePath: '',
          schemaPath: '#/required',
          params: { missingProperty: 'name' },
          message: 'must have required property name',
        } as ErrorObject,
        {
          keyword: 'type',
          instancePath: '/port',
          schemaPath: '#/properties/port/type',
          params: { type: 'number' },
          message: 'must be number',
        } as ErrorObject,
      ];

      const result = formatErrors(errors);
      expect(result).toBe('Missing required property: name; /port: must be number (expected number)');
    });

    it('should handle empty errors array', () => {
      const errors: ErrorObject[] = [];
      const result = formatErrors(errors);
      expect(result).toBe('Validation failed');
    });

    it('should handle generic errors', () => {
      const errors: ErrorObject[] = [
        {
          keyword: 'custom',
          instancePath: '/field',
          schemaPath: '#/properties/field/custom',
          params: {},
          message: 'custom validation failed',
        } as ErrorObject,
      ];

      const result = formatErrors(errors);
      expect(result).toBe('/field: custom validation failed');
    });
  });

  describe('validateSemiontConfig', () => {
    it('should validate valid semiont config', () => {
      const config = {
        version: '1.0.0',
        project: 'test-project',
        site: {
          domain: 'example.com',
        },
      };

      const result = validateSemiontConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject config missing site', () => {
      const config = {
        version: '1.0.0',
        project: 'test-project',
      };

      const result = validateSemiontConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errorMessage).toContain('site');
    });

    it('should reject config with invalid site structure', () => {
      const config = {
        version: '1.0.0',
        project: 'test-project',
        site: {
          siteName: 'Test',
          // Missing required domain
        },
      };

      const result = validateSemiontConfig(config);
      expect(result.valid).toBe(false);
    });
  });

  describe('validateEnvironmentConfig', () => {
    it('should validate valid environment config', () => {
      const config = {
        site: {
          domain: 'example.com',
        },
        env: {
          NODE_ENV: 'production',
        },
        services: {},
      };

      const result = validateEnvironmentConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject config missing services', () => {
      const config = {
        site: {
          domain: 'example.com',
        },
        env: {
          NODE_ENV: 'development',
        },
      };

      const result = validateEnvironmentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain('services');
    });

    it('should reject config with invalid NODE_ENV', () => {
      const config = {
        site: {
          domain: 'example.com',
        },
        env: {
          NODE_ENV: 'invalid',
        },
        services: {},
      };

      const result = validateEnvironmentConfig(config);
      expect(result.valid).toBe(false);
    });

    it('should accept config without env field', () => {
      const config = {
        site: {
          domain: 'example.com',
        },
        services: {},
      };

      const result = validateEnvironmentConfig(config);
      expect(result.valid).toBe(true);
    });
  });

  describe('validateSiteConfig', () => {
    it('should validate valid site config', () => {
      const config = {
        domain: 'example.com',
      };

      const result = validateSiteConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should validate site config with optional siteName', () => {
      const config = {
        domain: 'example.com',
        siteName: 'Test Site',
      };

      const result = validateSiteConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should reject config missing domain', () => {
      const config = {
        siteName: 'Test',
      };

      const result = validateSiteConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain('domain');
    });

    it('should reject empty site config', () => {
      const config = {};

      const result = validateSiteConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain('domain');
    });

    it('should validate site config with emails', () => {
      const config = {
        domain: 'example.com',
        adminEmail: 'admin@example.com',
        supportEmail: 'support@example.com',
      };

      const result = validateSiteConfig(config);
      expect(result.valid).toBe(true);
    });
  });
});
