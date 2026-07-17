/**
 * Config Read Retry Tests
 *
 * Environment resolution must distinguish "config file absent" from "config
 * file unreadable". Under Apple Container (virtiofs), mounting the same host
 * file into another VM transiently breaks existing mounts of that file
 * (~100ms read failures); such a blip must surface as a read error after
 * retries — never as "Environment not specified ... Available: none found".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { resolveEnvironment, getAvailableEnvironments } from '../core/config-loader.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

const CONFIG = `
[defaults]
environment = "local"

[environments.local.backend]
platform = "posix"
port = 4000
`;

/**
 * Make ~/.semiontconfig exist but fail its first `failures` reads with EIO.
 * Returns a getter for the number of read attempts made.
 */
function mockTransientReadFailure(failures: number): () => number {
  let attempts = 0;
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    attempts++;
    if (attempts <= failures) {
      throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    }
    return CONFIG;
  });
  return () => attempts;
}

describe('Config Read Retry', () => {
  let originalSemiontEnv: string | undefined;

  beforeEach(() => {
    originalSemiontEnv = process.env.SEMIONT_ENV;
    delete process.env.SEMIONT_ENV;
  });

  afterEach(() => {
    if (originalSemiontEnv !== undefined) {
      process.env.SEMIONT_ENV = originalSemiontEnv;
    }
  });

  it('retries a transient read failure and resolves the default environment', () => {
    const attempts = mockTransientReadFailure(1);

    expect(resolveEnvironment()).toBe('local');
    expect(attempts()).toBe(2);
  });

  it('reports the read failure — not "Environment not specified" — when reads keep failing', () => {
    mockTransientReadFailure(Infinity);

    let thrown: unknown;
    try {
      resolveEnvironment();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('Failed to read');
    expect(message).toContain('EIO');
    expect(message).not.toContain('Environment not specified');
  });

  it('retries transient read failures in getAvailableEnvironments', () => {
    const attempts = mockTransientReadFailure(2);

    expect(getAvailableEnvironments()).toEqual(['local']);
    expect(attempts()).toBe(3);
  });

  it('still reports "none found" when the config file is genuinely absent', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(() => resolveEnvironment()).toThrow(/Environment not specified.*none found/s);
    expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();
  });
});
