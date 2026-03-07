import { describe, it, expect } from 'vitest';
import {
  deepMerge,
  resolveEnvVars,
  parseAndMergeConfigs,
  listEnvironmentNames,
  getNodeEnvForEnvironment,
  hasAWSConfig,
} from '../../config/environment-loader';
import type { EnvironmentConfig } from '../../config/environment-loader';

describe('@semiont/core - environment-loader', () => {
  describe('deepMerge', () => {
    it('should merge two simple objects', () => {
      const target = { a: 1 };
      const source = { b: 2 };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it('should merge nested objects', () => {
      const target = { a: { x: 1 } };
      const source = { a: { y: 2 } };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: { x: 1, y: 2 } });
    });

    it('should override primitives', () => {
      const target = { a: 1 };
      const source = { a: 2 };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: 2 });
    });

    it('should merge multiple sources', () => {
      const target = { a: 1 };
      const source1 = { b: 2 };
      const source2 = { c: 3 };
      const result = deepMerge(target, source1, source2);
      expect(result).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('should handle arrays as values', () => {
      const target = { a: [1, 2] };
      const source = { a: [3, 4] };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: [3, 4] });
    });

    it('should handle empty objects', () => {
      const target = {};
      const source = { a: 1 };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: 1 });
    });

    it('should handle no sources', () => {
      const target = { a: 1 };
      const result = deepMerge(target);
      expect(result).toEqual({ a: 1 });
    });

    it('should create nested objects if they do not exist', () => {
      const target = {};
      const source = { a: { b: { c: 1 } } };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: { b: { c: 1 } } });
    });
  });

  describe('resolveEnvVars', () => {
    it('should resolve environment variables in strings', () => {
      const obj = 'Hello ${NAME}';
      const env = { NAME: 'World' };
      const result = resolveEnvVars(obj, env);
      expect(result).toBe('Hello World');
    });

    it('should resolve multiple environment variables', () => {
      const obj = '${GREETING} ${NAME}';
      const env = { GREETING: 'Hello', NAME: 'World' };
      const result = resolveEnvVars(obj, env);
      expect(result).toBe('Hello World');
    });

    it('should leave unresolved variables as-is', () => {
      const obj = 'Hello ${NAME}';
      const env = {};
      const result = resolveEnvVars(obj, env);
      expect(result).toBe('Hello ${NAME}');
    });

    it('should resolve environment variables in nested objects', () => {
      const obj = {
        greeting: 'Hello ${NAME}',
        nested: {
          message: 'Welcome ${USER}',
        },
      };
      const env = { NAME: 'World', USER: 'Alice' };
      const result = resolveEnvVars(obj, env);
      expect(result).toEqual({
        greeting: 'Hello World',
        nested: {
          message: 'Welcome Alice',
        },
      });
    });

    it('should resolve environment variables in arrays', () => {
      const obj = ['${A}', '${B}', '${C}'];
      const env = { A: '1', B: '2', C: '3' };
      const result = resolveEnvVars(obj, env);
      expect(result).toEqual(['1', '2', '3']);
    });

    it('should handle primitives', () => {
      expect(resolveEnvVars(42, {})).toBe(42);
      expect(resolveEnvVars(true, {})).toBe(true);
      expect(resolveEnvVars(null, {})).toBe(null);
    });

    it('should handle undefined env values', () => {
      const obj = 'Hello ${NAME}';
      const env = { NAME: undefined };
      const result = resolveEnvVars(obj, env);
      expect(result).toBe('Hello ${NAME}');
    });

    it('should resolve nested arrays in objects', () => {
      const obj = {
        items: ['${A}', '${B}'],
      };
      const env = { A: 'first', B: 'second' };
      const result = resolveEnvVars(obj, env);
      expect(result).toEqual({
        items: ['first', 'second'],
      });
    });
  });

  describe('parseAndMergeConfigs', () => {
    it('should parse and merge valid configs', () => {
      const baseContent = JSON.stringify({
        site: { domain: 'example.com', siteName: 'Test Site' },
        defaults: { env: { NODE_ENV: 'development' } },
      });
      const envContent = JSON.stringify({
        env: { NODE_ENV: 'production' },
        services: {},
      });
      const env = {};
      const result = parseAndMergeConfigs(baseContent, envContent, env, 'prod', '/test');

      expect(result.site?.siteName).toBe('Test Site');
      expect(result.env?.NODE_ENV).toBe('production');
      expect(result._metadata?.environment).toBe('prod');
    });

    it('should handle null base content', () => {
      const envContent = JSON.stringify({
        site: { domain: 'example.com' },
        env: { NODE_ENV: 'development' },
        services: {},
      });
      const env = {};
      const result = parseAndMergeConfigs(null, envContent, env, 'dev', '/test');

      expect(result.site?.domain).toBe('example.com');
    });

    it('should resolve environment variables', () => {
      const envContent = JSON.stringify({
        site: { domain: '${DOMAIN}', siteName: '${SITE_NAME}' },
        env: { NODE_ENV: 'development' },
        services: {},
      });
      const env = { DOMAIN: 'example.com', SITE_NAME: 'My Site' };
      const result = parseAndMergeConfigs(null, envContent, env, 'dev', '/test');

      expect(result.site?.domain).toBe('example.com');
      expect(result.site?.siteName).toBe('My Site');
    });

    it('should throw on invalid JSON in base content', () => {
      const baseContent = 'invalid json';
      const envContent = JSON.stringify({ services: {} });
      const env = {};

      expect(() => parseAndMergeConfigs(baseContent, envContent, env, 'dev', '/test'))
        .toThrow(/JSON syntax/);
    });

    it('should throw on invalid JSON in env content', () => {
      const baseContent = null;
      const envContent = 'invalid json';
      const env = {};

      expect(() => parseAndMergeConfigs(baseContent, envContent, env, 'dev', '/test'))
        .toThrow(/JSON syntax/);
    });

    it('should throw on invalid NODE_ENV value', () => {
      const baseContent = null;
      const envContent = JSON.stringify({
        site: { domain: 'example.com' },
        env: { NODE_ENV: 'invalid' },
        services: {},
      });
      const env = {};

      expect(() => parseAndMergeConfigs(baseContent, envContent, env, 'dev', '/test'))
        .toThrow(/Invalid NODE_ENV value/);
    });

    it('should accept valid NODE_ENV values', () => {
      const validValues = ['development', 'production', 'test'];

      for (const nodeEnv of validValues) {
        const envContent = JSON.stringify({
          site: { domain: 'example.com' },
          env: { NODE_ENV: nodeEnv },
          services: {},
        });
        const result = parseAndMergeConfigs(null, envContent, {}, 'dev', '/test');
        expect(result.env?.NODE_ENV).toBe(nodeEnv);
      }
    });

    it('should ensure services exists', () => {
      const envContent = JSON.stringify({
        site: { domain: 'example.com' },
        env: { NODE_ENV: 'development' },
      });
      const result = parseAndMergeConfigs(null, envContent, {}, 'dev', '/test');

      expect(result.services).toBeDefined();
      expect(result.services).toEqual({});
    });

    it('should add metadata', () => {
      const envContent = JSON.stringify({
        site: { domain: 'example.com' },
        env: { NODE_ENV: 'development' },
        services: {},
      });
      const result = parseAndMergeConfigs(null, envContent, {}, 'prod', '/my/project');

      expect(result._metadata).toBeDefined();
      expect(result._metadata?.environment).toBe('prod');
      expect(result._metadata?.projectRoot).toBe('/my/project');
    });

    it('should throw on schema validation errors', () => {
      const envContent = JSON.stringify({
        site: { domain: 'example.com' },
        env: { NODE_ENV: 'development' },
        services: {},
        invalidField: 'not allowed', // additionalProperties: false
      });

      expect(() => parseAndMergeConfigs(null, envContent, {}, 'dev', '/test'))
        .toThrow(/Invalid environment configuration/);
    });
  });

  describe('listEnvironmentNames', () => {
    it('should list environment names from JSON files', () => {
      const files = ['dev.json', 'prod.json', 'staging.json'];
      const result = listEnvironmentNames(files);
      expect(result).toEqual(['dev', 'prod', 'staging']);
    });

    it('should filter out non-JSON files', () => {
      const files = ['dev.json', 'README.md', 'prod.json', 'notes.txt'];
      const result = listEnvironmentNames(files);
      expect(result).toEqual(['dev', 'prod']);
    });

    it('should sort environment names', () => {
      const files = ['z.json', 'a.json', 'm.json'];
      const result = listEnvironmentNames(files);
      expect(result).toEqual(['a', 'm', 'z']);
    });

    it('should handle empty array', () => {
      const files: string[] = [];
      const result = listEnvironmentNames(files);
      expect(result).toEqual([]);
    });

    it('should handle files with multiple dots', () => {
      const files = ['dev.local.json', 'prod.json'];
      const result = listEnvironmentNames(files);
      expect(result).toEqual(['dev.local', 'prod']);
    });

    it('should handle paths with directories', () => {
      const files = ['configs/dev.json', 'prod.json'];
      const result = listEnvironmentNames(files);
      // path.basename just returns the filename without directory
      expect(result).toEqual(['dev', 'prod']);
    });
  });

  describe('getNodeEnvForEnvironment', () => {
    it('should return NODE_ENV from config', () => {
      const config = {
        env: { NODE_ENV: 'production' },
      } as EnvironmentConfig;

      const result = getNodeEnvForEnvironment(config);
      expect(result).toBe('production');
    });

    it('should default to development if not specified', () => {
      const config = {} as EnvironmentConfig;

      const result = getNodeEnvForEnvironment(config);
      expect(result).toBe('development');
    });

    it('should default to development if env is empty', () => {
      const config = {
        env: {},
      } as EnvironmentConfig;

      const result = getNodeEnvForEnvironment(config);
      expect(result).toBe('development');
    });

    it('should handle test environment', () => {
      const config = {
        env: { NODE_ENV: 'test' },
      } as EnvironmentConfig;

      const result = getNodeEnvForEnvironment(config);
      expect(result).toBe('test');
    });
  });

  describe('hasAWSConfig', () => {
    it('should return true for config with AWS settings', () => {
      const config = {
        aws: {
          region: 'us-east-1',
          accountId: '123456789',
        },
      } as any;

      expect(hasAWSConfig(config)).toBe(true);
    });

    it('should return false for config without AWS settings', () => {
      const config = {} as EnvironmentConfig;

      expect(hasAWSConfig(config)).toBe(false);
    });

    it('should return false for config with AWS but no region', () => {
      const config = {
        aws: {
          accountId: '123456789',
        },
      } as any;

      expect(hasAWSConfig(config)).toBe(false);
    });

    it('should return false for config with empty AWS', () => {
      const config = {
        aws: {},
      } as any;

      expect(hasAWSConfig(config)).toBe(false);
    });
  });
});
