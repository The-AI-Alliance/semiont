/**
 * Backend Configuration Utilities
 *
 * Node.js-specific config loading using @semiont/core's TOML loader.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createTomlConfigLoader, type TomlFileReader, type EnvironmentConfig } from '@semiont/core';
import type { MakeMeaningConfig } from '@semiont/make-meaning';

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
export function loadEnvironmentConfig(projectRoot: string, environment: string): EnvironmentConfig {
  const globalConfigPath = path.join(os.homedir(), '.semiontconfig');
  return createTomlConfigLoader(nodeTomlFileReader, globalConfigPath, process.env)(projectRoot, environment);
}

/**
 * Extract the MakeMeaningConfig slice from a full EnvironmentConfig.
 * actors and workers come from _metadata (populated by the TOML loader).
 */
export function makeMeaningConfigFrom(config: EnvironmentConfig): MakeMeaningConfig {
  const meta = config._metadata as (EnvironmentConfig['_metadata'] & {
    actors?: MakeMeaningConfig['actors'];
    workers?: MakeMeaningConfig['workers'];
  }) | undefined;

  return {
    services: {
      graph: config.services?.graph,
    },
    actors: meta?.actors,
    workers: meta?.workers,
  };
}
