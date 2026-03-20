/**
 * Backend Configuration Utilities
 *
 * Node.js-specific config loading using @semiont/core's createConfigLoader
 */

import * as fs from 'fs';
import * as path from 'path';
import { createConfigLoader, createTomlConfigLoader, type ConfigFileReader, type TomlFileReader, type EnvironmentConfig } from '@semiont/core';
import type { MakeMeaningConfig } from '@semiont/make-meaning';

/**
 * Node.js file reader implementation for JSON config loading (legacy)
 */
const nodeFileReader: ConfigFileReader = {
  readIfExists: (filePath: string) => {
    const absolutePath = path.resolve(filePath);
    return fs.existsSync(absolutePath)
      ? fs.readFileSync(absolutePath, 'utf-8')
      : null;
  },

  readRequired: (filePath: string) => {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Configuration file not found: ${absolutePath}`);
    }
    return fs.readFileSync(absolutePath, 'utf-8');
  },
};

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
 * Load environment configuration from JSON files (legacy: semiont.json + environments/{env}.json)
 */
export const loadEnvironmentConfig = createConfigLoader(nodeFileReader);

/**
 * Load environment configuration from TOML files (~/.semiontconfig + .semiont/config)
 */
export function loadTomlEnvironmentConfig(projectRoot: string, environment: string): EnvironmentConfig {
  const globalConfigPath = `${process.env.HOME}/.semiontconfig`;
  const loader = createTomlConfigLoader(nodeTomlFileReader, globalConfigPath, process.env as Record<string, string | undefined>);
  return loader(projectRoot, environment);
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
    _metadata: config._metadata?.projectRoot
      ? { projectRoot: config._metadata.projectRoot }
      : undefined,
  };
}
