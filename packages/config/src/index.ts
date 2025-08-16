// Export all configuration functionality
export {
  loadEnvironmentConfig,
  getAvailableEnvironments,
  isValidEnvironment,
  findProjectRoot,
} from './loader.js';

export type {
  EnvironmentConfig,
} from './types.js';

export {
  EnvironmentConfigSchema,
} from './types.js';

// Re-export types for convenience
export type { EnvironmentConfig as Config } from './types.js';