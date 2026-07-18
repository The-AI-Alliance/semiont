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
    gather?: MakeMeaningConfig['gather'];
  }) | undefined;

  // The TOML loader always sets _metadata.gather (it owns the one default —
  // D5). A missing value means this config bypassed the loader: fail loudly
  // rather than default here.
  const gather = meta?.gather;
  if (!gather) {
    throw new Error('make-meaning gather config missing — load config via loadEnvironmentConfig (the TOML loader owns the settleTimeoutMs default)');
  }

  return {
    gather,
    services: {
      graph: config.services?.graph,
      vectors: config.services?.vectors,
      embedding: config.services?.embedding,
    },
    // The KB's canonical identity — the agent roster mints DIDs from this,
    // the SAME value /api/tokens/agent uses (agent-did-host-skew fix). The
    // value, not JWTService, so make-meaning stays backend-agnostic.
    ...(config.site?.domain ? { site: { domain: config.site.domain } } : {}),
    actors: meta?.actors,
    workers: meta?.workers,
  };
}
