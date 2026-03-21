import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTomlConfigLoader } from './toml-loader.js';
import type { EnvironmentConfig } from './config.types.js';

const nodeTomlFileReader = {
  readIfExists: (filePath: string): string | null =>
    fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null,
};

/**
 * Load semiont environment config for a Node.js process.
 *
 * Reads ~/.semiontconfig (global) merged with .semiont/config (project-local),
 * then selects the given environment overlay.
 *
 * This is the canonical config loader for any Node.js process. SEMIONT_ENV
 * should be read once at the process entry point and passed as `environment`.
 */
export function loadEnvironmentConfig(
  projectRoot: string,
  environment: string
): EnvironmentConfig {
  const globalConfigPath = path.join(os.homedir(), '.semiontconfig');
  return createTomlConfigLoader(
    nodeTomlFileReader,
    globalConfigPath,
    process.env
  )(projectRoot, environment);
}
