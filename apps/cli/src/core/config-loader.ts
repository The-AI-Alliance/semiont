/**
 * Configuration Loader for CLI
 *
 * Filesystem wrapper around @semiont/core's TOML config functions.
 * This keeps fs operations out of the core package.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseToml } from 'smol-toml';
import { createTomlConfigLoader, ConfigurationError, type TomlFileReader } from '@semiont/core';

/**
 * Find project root by walking up from cwd looking for .semiont/.
 * SEMIONT_ROOT, if set, is used as an explicit override (analogous to GIT_DIR).
 */
export function findProjectRoot(): string {
  // Explicit override — skip the walk
  const override = process.env.SEMIONT_ROOT;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new ConfigurationError(
        `SEMIONT_ROOT points to non-existent directory: ${override}`,
        undefined,
        'Check that SEMIONT_ROOT is set correctly'
      );
    }
    if (!fs.existsSync(path.join(override, '.semiont'))) {
      throw new ConfigurationError(
        `SEMIONT_ROOT does not contain a .semiont/ directory: ${override}`,
        undefined,
        'Run: semiont init'
      );
    }
    return override;
  }

  // Walk up from cwd (analogous to git's .git/ discovery)
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, '.semiont'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  throw new ConfigurationError(
    'No .semiont/ directory found in current directory or any parent',
    undefined,
    'Run: semiont init'
  );
}

/**
 * Like findProjectRoot() but returns null instead of throwing when no project is found.
 * Use for commands that can operate without a project (e.g. frontend-only operations).
 */
export function findProjectRootOrNull(): string | null {
  try {
    return findProjectRoot();
  } catch {
    return null;
  }
}

// Config reads must distinguish "file absent" from "file unreadable". Under
// Apple Container (virtiofs), mounting the same host file into another VM
// transiently breaks existing mounts of that file (~100ms read failures), so
// a read that throws is retried briefly before being reported as an error —
// never silently treated as "not configured".
const READ_RETRY_ATTEMPTS = 3;
const READ_RETRY_DELAY_MS = 150;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read a file, returning null only if it is absent. Transient read failures
 * are retried; if the file exists but still cannot be read, throws a
 * ConfigurationError naming the I/O failure.
 */
function readFileIfExistsWithRetry(absolutePath: string): string | null {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 1) sleepSync(READ_RETRY_DELAY_MS);
    if (!fs.existsSync(absolutePath)) return null;
    try {
      return fs.readFileSync(absolutePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new ConfigurationError(
    `Failed to read ${absolutePath} after ${READ_RETRY_ATTEMPTS} attempts: ${lastError!.message}`,
    undefined,
    'The file exists but could not be read (possibly a transient filesystem error) — retry the command',
    lastError
  );
}

/**
 * Node.js file reader for TOML config loading
 */
const nodeTomlFileReader: TomlFileReader = {
  readIfExists: (filePath: string) => readFileIfExistsWithRetry(path.resolve(filePath)),
};

function semiontConfigPath(): string {
  return path.join(os.homedir(), '.semiontconfig');
}

/**
 * Load environment configuration from ~/.semiontconfig (TOML)
 */
export function loadEnvironmentConfig(projectRoot: string | null, environment: string) {
  return createTomlConfigLoader(nodeTomlFileReader, semiontConfigPath(), process.env)(projectRoot, environment);
}

/**
 * Resolve the active environment from (in order of precedence):
 *   1. explicit value passed in (e.g. from --environment flag)
 *   2. SEMIONT_ENV environment variable
 *   3. defaults.environment in ~/.semiontconfig
 *
 * Throws if none of the above yields a value.
 */
export function resolveEnvironment(explicit?: string): string {
  const resolved = explicit || process.env.SEMIONT_ENV || readDefaultEnvironment();
  if (resolved) return resolved;
  const availableEnvs = getAvailableEnvironments();
  throw new Error(
    `Environment not specified. Use --environment flag, set SEMIONT_ENV, or set defaults.environment in ~/.semiontconfig. ` +
    `Available: ${availableEnvs.length > 0 ? availableEnvs.join(', ') : 'none found'}`
  );
}

function readDefaultEnvironment(): string | null {
  const content = readFileIfExistsWithRetry(semiontConfigPath());
  if (!content) return null;
  const parsed = parseToml(content) as { defaults?: { environment?: string } };
  return parsed.defaults?.environment ?? null;
}

/**
 * Get available environments from ~/.semiontconfig [environments.*] keys
 */
export function getAvailableEnvironments(): string[] {
  const content = readFileIfExistsWithRetry(semiontConfigPath());
  if (!content) return [];
  const parsed = parseToml(content) as { environments?: Record<string, unknown> };
  return Object.keys(parsed.environments ?? {}).sort();
}

/**
 * Check if an environment exists
 */
export function isValidEnvironment(environment: string): boolean {
  return getAvailableEnvironments().includes(environment);
}
