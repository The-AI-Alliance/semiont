/**
 * Backend Configuration Utilities
 *
 * Node.js-specific config loading using @semiont/core's createConfigLoader
 */

import * as fs from 'fs';
import * as path from 'path';
import { createConfigLoader, type ConfigFileReader } from '@semiont/core';

/**
 * Node.js file reader implementation for config loading
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
 * Load environment configuration from filesystem
 * Uses Node.js fs module for file I/O
 *
 * @param projectRoot - Absolute path to project root
 * @param environment - Environment name (e.g., 'local', 'production')
 * @returns Merged and validated environment configuration
 *
 * @example
 * ```typescript
 * const projectRoot = process.env.SEMIONT_ROOT;
 * if (!projectRoot) throw new Error('SEMIONT_ROOT not set');
 * const config = loadEnvironmentConfig(projectRoot, 'production');
 * ```
 */
export const loadEnvironmentConfig = createConfigLoader(nodeFileReader);
