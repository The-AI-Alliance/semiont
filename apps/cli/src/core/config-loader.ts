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
 * Node.js file reader for TOML config loading
 */
const nodeTomlFileReader: TomlFileReader = {
  readIfExists: (filePath: string) => {
    const absolutePath = path.resolve(filePath);
    return fs.existsSync(absolutePath)
      ? fs.readFileSync(absolutePath, 'utf-8')
      : null;
  },
};

/**
 * Load environment configuration from ~/.semiontconfig (TOML)
 */
export function loadEnvironmentConfig(projectRoot: string, environment: string) {
  const configPath = path.join(os.homedir(), '.semiontconfig');
  return createTomlConfigLoader(nodeTomlFileReader, configPath, process.env)(projectRoot, environment);
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
  const configPath = path.join(os.homedir(), '.semiontconfig');
  try {
    const content = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, 'utf-8')
      : null;
    if (!content) return null;
    const parsed = parseToml(content) as { defaults?: { environment?: string } };
    return parsed.defaults?.environment ?? null;
  } catch {
    return null;
  }
}

/**
 * Get available environments from ~/.semiontconfig [environments.*] keys
 */
export function getAvailableEnvironments(): string[] {
  const configPath = path.join(os.homedir(), '.semiontconfig');
  try {
    const content = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, 'utf-8')
      : null;
    if (!content) return [];
    const parsed = parseToml(content) as { environments?: Record<string, unknown> };
    return Object.keys(parsed.environments ?? {}).sort();
  } catch {
    return [];
  }
}

/**
 * Check if an environment exists
 */
export function isValidEnvironment(environment: string): boolean {
  return getAvailableEnvironments().includes(environment);
}

/**
 * Read the project name from .semiont/config ([project] name = "...").
 * Falls back to the basename of projectRoot if the file is absent or has no name key.
 */
