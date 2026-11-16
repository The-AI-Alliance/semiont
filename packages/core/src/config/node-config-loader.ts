import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTomlConfigLoader } from './toml-loader.js';
import type { EnvironmentConfig } from './config.types.js';

export { SemiontProject } from '../project.js';

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
 * This is the canonical config loader for any Node.js process. The environment
 * is resolved by the loader itself — an explicit `environment` argument, else
 * `[defaults] environment` from the committed config — so entry points call this
 * without selecting one; one config selects the environment for the backend the
 * same way the launcher selects it. There is no environment-variable override.
 */
export function loadEnvironmentConfig(
  projectRoot: string,
  environment?: string
): EnvironmentConfig {
  const globalConfigPath = path.join(os.homedir(), '.semiontconfig');
  return createTomlConfigLoader(
    nodeTomlFileReader,
    globalConfigPath,
    process.env
  )(projectRoot, environment);
}
