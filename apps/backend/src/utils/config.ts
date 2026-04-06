/**
 * Backend Configuration Utilities
 */

import type { EnvironmentConfig } from '@semiont/core';
import type { MakeMeaningConfig } from '@semiont/make-meaning';

export { loadEnvironmentConfig } from '@semiont/core/node';

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
      vectors: config.services?.vectors,
    },
    actors: meta?.actors,
    workers: meta?.workers,
  };
}
