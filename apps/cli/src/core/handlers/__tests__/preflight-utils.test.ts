/**
 * Preflight Utils Tests
 *
 * Tests the shared preflight check utility functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as child_process from 'child_process';
import * as fs from 'fs';

// Mock child_process.execFileSync
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  accessSync: vi.fn(),
  constants: { W_OK: 2 },
}));

import {
  checkCommandAvailable,
  checkContainerRuntime,
  checkEnvVarResolved,
  checkEnvVarsInConfig,
  checkFileExists,
  checkDirectoryWritable,
  checkAwsCredentials,
  checkPortFree,
  passingPreflight,
  preflightFromChecks,
} from '../preflight-utils.js';

describe('preflight-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkCommandAvailable', () => {
    it('should pass when command exists', () => {
      vi.mocked(child_process.execFileSync).mockReturnValue(Buffer.from('/usr/bin/node'));
      const result = checkCommandAvailable('node');
      expect(result).toEqual({ name: 'command-node', pass: true, message: 'node is available' });
    });

    it('should fail when command does not exist', () => {
      vi.mocked(child_process.execFileSync).mockImplementation(() => { throw new Error('not found'); });
      const result = checkCommandAvailable('nonexistent');
      expect(result).toEqual({ name: 'command-nonexistent', pass: false, message: 'nonexistent is not installed or not in PATH' });
    });
  });

  describe('checkContainerRuntime', () => {
    it('should pass when runtime is available', () => {
      vi.mocked(child_process.execFileSync).mockReturnValue(Buffer.from('Docker version 24.0'));
      const result = checkContainerRuntime('docker');
      expect(result).toEqual({ name: 'container-runtime', pass: true, message: 'docker is available' });
    });

    it('should fail when runtime is not available', () => {
      vi.mocked(child_process.execFileSync).mockImplementation(() => { throw new Error('not found'); });
      const result = checkContainerRuntime('podman');
      expect(result).toEqual({ name: 'container-runtime', pass: false, message: 'podman is not installed or not in PATH' });
    });
  });

  describe('checkEnvVarResolved', () => {
    it('should fail when value is undefined', () => {
      const result = checkEnvVarResolved(undefined, 'API_KEY');
      expect(result.pass).toBe(false);
      expect(result.message).toContain('not configured');
    });

    it('should pass when value is a literal string', () => {
      const result = checkEnvVarResolved('some-value', 'API_KEY');
      expect(result.pass).toBe(true);
      expect(result.message).toContain('configured');
    });

    it('should check env var when value contains ${VAR} template', () => {
      const original = process.env.MY_SECRET;
      process.env.MY_SECRET = 'resolved-value';
      const result = checkEnvVarResolved('${MY_SECRET}', 'secret');
      expect(result.pass).toBe(true);
      expect(result.name).toBe('env-MY_SECRET');
      if (original === undefined) delete process.env.MY_SECRET;
      else process.env.MY_SECRET = original;
    });

    it('should fail when env var template is unresolved', () => {
      const original = process.env.MISSING_VAR;
      delete process.env.MISSING_VAR;
      const result = checkEnvVarResolved('${MISSING_VAR}', 'secret');
      expect(result.pass).toBe(false);
      expect(result.message).toContain('MISSING_VAR is not set');
      if (original !== undefined) process.env.MISSING_VAR = original;
    });
  });

  describe('checkEnvVarsInConfig', () => {
    it('should return empty checks for config without env vars', () => {
      const checks = checkEnvVarsInConfig({ host: 'localhost', port: 3000 });
      expect(checks).toEqual([]);
    });

    it('should detect env vars in nested config', () => {
      const original = process.env.DB_HOST;
      delete process.env.DB_HOST;
      const checks = checkEnvVarsInConfig({
        database: { host: '${DB_HOST}', port: 5432 },
      });
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ name: 'env-DB_HOST', pass: false });
      if (original !== undefined) process.env.DB_HOST = original;
    });

    it('should detect env vars in arrays', () => {
      const original = process.env.ITEM_VAR;
      process.env.ITEM_VAR = 'value';
      const checks = checkEnvVarsInConfig({ list: ['${ITEM_VAR}'] });
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ pass: true });
      if (original === undefined) delete process.env.ITEM_VAR;
      else process.env.ITEM_VAR = original;
    });

    it('should deduplicate repeated env var references', () => {
      const original = process.env.REPEATED;
      delete process.env.REPEATED;
      const checks = checkEnvVarsInConfig({
        a: '${REPEATED}',
        b: '${REPEATED}',
      });
      expect(checks).toHaveLength(1);
      if (original !== undefined) process.env.REPEATED = original;
    });
  });

  describe('checkFileExists', () => {
    it('should pass when file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = checkFileExists('/some/path', 'config file');
      expect(result).toEqual({ name: 'file-config file', pass: true, message: 'config file exists' });
    });

    it('should fail when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const result = checkFileExists('/missing/path', 'config file');
      expect(result.pass).toBe(false);
      expect(result.message).toContain('not found');
    });
  });

  describe('checkDirectoryWritable', () => {
    it('should pass when directory is writable', () => {
      vi.mocked(fs.accessSync).mockReturnValue(undefined);
      const result = checkDirectoryWritable('/tmp');
      expect(result.pass).toBe(true);
    });

    it('should fail when directory is not writable', () => {
      vi.mocked(fs.accessSync).mockImplementation(() => { throw new Error('EACCES'); });
      const result = checkDirectoryWritable('/readonly');
      expect(result.pass).toBe(false);
    });
  });

  describe('checkAwsCredentials', () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = {
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
        AWS_PROFILE: process.env.AWS_PROFILE,
        HOME: process.env.HOME,
      };
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('should pass when AWS keys are set', () => {
      process.env.AWS_ACCESS_KEY_ID = 'AKIA...';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';
      const result = checkAwsCredentials();
      expect(result.pass).toBe(true);
    });

    it('should pass when AWS_PROFILE is set', () => {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      process.env.AWS_PROFILE = 'my-profile';
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const result = checkAwsCredentials();
      expect(result.pass).toBe(true);
    });

    it('should pass when ~/.aws/credentials exists', () => {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AWS_PROFILE;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result = checkAwsCredentials();
      expect(result.pass).toBe(true);
    });

    it('should fail when no credentials are configured', () => {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AWS_PROFILE;
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const result = checkAwsCredentials();
      expect(result.pass).toBe(false);
    });
  });

  describe('checkPortFree', () => {
    it('should pass when port is free', async () => {
      // Use a high ephemeral port unlikely to be in use
      const result = await checkPortFree(0); // port 0 lets OS pick a free port
      // Port 0 always succeeds since the OS picks a free port
      expect(result.pass).toBe(true);
    });

    // Testing port-in-use would require actually binding a port, which is flaky in CI
  });

  describe('passingPreflight', () => {
    it('should return a passing result with no checks', () => {
      const result = passingPreflight();
      expect(result).toEqual({ pass: true, checks: [] });
    });
  });

  describe('preflightFromChecks', () => {
    it('should pass when all checks pass', () => {
      const checks = [
        { name: 'a', pass: true, message: 'ok' },
        { name: 'b', pass: true, message: 'ok' },
      ];
      const result = preflightFromChecks(checks);
      expect(result.pass).toBe(true);
      expect(result.checks).toBe(checks);
    });

    it('should fail when any check fails', () => {
      const checks = [
        { name: 'a', pass: true, message: 'ok' },
        { name: 'b', pass: false, message: 'fail' },
      ];
      const result = preflightFromChecks(checks);
      expect(result.pass).toBe(false);
    });

    it('should pass for empty checks array', () => {
      const result = preflightFromChecks([]);
      expect(result.pass).toBe(true);
    });
  });
});
