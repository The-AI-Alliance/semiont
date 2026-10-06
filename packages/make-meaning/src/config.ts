import type { GraphServiceConfig, VectorsServiceConfig, EmbeddingServiceConfig, ArchivistServiceConfig, EnvironmentConfig } from '@semiont/core';

/**
 * Inference configuration for a single actor or worker.
 */
export interface InferenceConfig {
  type: 'anthropic' | 'ollama';
  model: string;
  maxTokens?: number;
  apiKey?: string;
  endpoint?: string;
  baseURL?: string;
}

/**
 * Per-actor inference overrides.
 */
export interface ActorInferenceConfig {
  gatherer?: InferenceConfig;
  matcher?: InferenceConfig;
}

/** Narrow config type — only the fields make-meaning actually reads */
export interface MakeMeaningConfig {
  /**
   * Resource-gather policy. `settleTimeoutMs` bounds the semanticContext
   * read-your-writes barrier, which degrades to an absent semanticContext on
   * timeout — REQUIRED: the TOML loader owns the one default (15s at
   * `[environments.<env>.make-meaning.gather]`); hand-built configs (scripts,
   * tests) state their policy explicitly. Must nest inside downstream
   * watchdogs: the gather's worst-case barrier spend stays below the
   * job-worker and client stall watchdogs.
   */
  gather: { settleTimeoutMs: number };
  /**
   * Search policy. `semanticFloor` is the minimum cosine score a vector hit
   * needs to appear in the semantic fallback — REQUIRED: the TOML loader owns
   * the one default (0.6 at `[environments.<env>.make-meaning.search]`);
   * hand-built configs (scripts, tests) state their policy explicitly.
   */
  search: { semanticFloor: number };
  services: {
    graph?: GraphServiceConfig;
    /** REQUIRED, at the type level: a vector store is
     *  mandatory and nothing is defaulted, so the config NAMES its store —
     *  `memory` is a first-class explicit choice, never a fallback. The TOML
     *  loader refuses configs without it; the type makes hand-built configs
     *  state their choice. */
    vectors: VectorsServiceConfig;
    /** REQUIRED, likewise: the embedding provider is the KB's semantic
     *  identity — always named, never detected or defaulted. */
    embedding: EmbeddingServiceConfig;
    /** Where the record is. Optional in the type because the actors that
     *  hold a KB mount never dial it; the Librarian does, to read bytes
     *  straight from the Archivist, and refuses at boot when it is absent. */
    archivist?: ArchivistServiceConfig;
  };
  /** Per-actor inference config */
  actors?: ActorInferenceConfig;
}

/**
 * The KB name a mountless service composes its state paths from —
 * `[kb] name`, staged by the launcher from the KB's committed identity.
 * Refusing is the point: a defaulted name composes a state path nobody writes
 * to, and the service reads an empty view store forever, silently.
 */
export function requireKBName(config: EnvironmentConfig): string {
  const name = config.kb?.name;
  if (!name) {
    throw new Error(
      '[kb] name is missing from the environment config. The launcher stages the ' +
        "KB's committed identity into each service's config; " +
        'without it this service cannot locate the state tree.',
    );
  }
  return name;
}

/**
 * The make-meaning view of a loaded config. Every part DELEGATES to the loaded
 * config at its read rather than copying at construction: a service reads only
 * the sections specs/src/service-config/sections.json lists for it, so copying
 * a part it never uses would be a read of a section it does not declare,
 * which the loader refuses. `gather`, `search` and `actors` come from
 * `_metadata`, which the TOML loader populates.
 */
export function makeMeaningConfigFrom(config: EnvironmentConfig): MakeMeaningConfig {
  const meta = () => config._metadata as (EnvironmentConfig['_metadata'] & {
    actors?: MakeMeaningConfig['actors'];
    gather?: MakeMeaningConfig['gather'];
    search?: MakeMeaningConfig['search'];
  }) | undefined;

  return {
    // The TOML loader always sets _metadata.gather and .search (it owns the one
    // default). A missing value means this config bypassed the loader:
    // fail loudly rather than default here.
    get gather() {
      const gather = meta()?.gather;
      if (!gather) {
        throw new Error('make-meaning gather config missing — load config via loadEnvironmentConfig (the TOML loader owns the settleTimeoutMs default)');
      }
      return gather;
    },
    get search() {
      const search = meta()?.search;
      if (!search) {
        throw new Error('make-meaning search config missing — load config via loadEnvironmentConfig (the TOML loader owns the semanticFloor default)');
      }
      return search;
    },
    services: {
      // vectors/embedding are required on both sides: core's ServicesConfig
      // requires the pair, and the loader refuses a config missing either at
      // their read — nothing to re-check here.
      get graph() { return config.services.graph; },
      get vectors() { return config.services.vectors; },
      get embedding() { return config.services.embedding; },
      get archivist() { return config.services.archivist; },
    },
    get actors() { return meta()?.actors; },
  };
}

/**
 * Resolve inference config for a named actor.
 */
export function resolveActorInference(
  config: Pick<MakeMeaningConfig, 'actors'>,
  actor: 'gatherer' | 'matcher'
): InferenceConfig {
  const specific = config.actors?.[actor];
  if (specific) return specific;

  throw new Error(
    `No inference config found for actor '${actor}'. ` +
    `Set actors.${actor}.inference in your config.`
  );
}
