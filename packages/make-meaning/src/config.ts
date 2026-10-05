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
 * Stower never calls an LLM, so it has no entry here.
 */
export interface ActorInferenceConfig {
  gatherer?: InferenceConfig;
  matcher?: InferenceConfig;
}

/**
 * Per-worker-type inference overrides.
 * Falls back to `workers.default` if a specific worker is not listed.
 */
export interface WorkerInferenceConfig {
  default?: InferenceConfig;
  'reference-annotation'?: InferenceConfig;
  'highlight-annotation'?: InferenceConfig;
  'assessment-annotation'?: InferenceConfig;
  'comment-annotation'?: InferenceConfig;
  'tag-annotation'?: InferenceConfig;
  'generation'?: InferenceConfig;
}

/** Who serves a role: its provider and model, and no credential. */
export type RoleInference = Pick<InferenceConfig, 'type' | 'model'>;

/**
 * The collaborator roster's input: each role's provider and model. The
 * credentialed `MakeMeaningConfig` is one, since its entries carry more; the
 * archivist, which holds no inference credential, builds one from the keyless
 * role maps (`rosterConfigFrom`).
 */
export interface RosterConfig {
  workers?: { [R in keyof WorkerInferenceConfig]?: RoleInference };
  actors?: { [A in keyof ActorInferenceConfig]?: RoleInference };
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
  /** Per-worker-type inference config */
  workers?: WorkerInferenceConfig;
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
 * a part it never uses (the dispatcher's graph, the Librarian's workers) would
 * be a read of a section it does not declare, which the loader refuses.
 * `gather`, `search`, `actors` and `workers` come from `_metadata`, which the
 * TOML loader populates.
 *
 * Lives here (not in a consumer) because every entry point that starts from
 * a loaded config — archivist-main, librarian-main, the rebuild-projections
 * CLI — needs the identical mapping; two copies would drift.
 */
export function makeMeaningConfigFrom(config: EnvironmentConfig): MakeMeaningConfig {
  const meta = () => config._metadata as (EnvironmentConfig['_metadata'] & {
    actors?: MakeMeaningConfig['actors'];
    workers?: MakeMeaningConfig['workers'];
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
    get workers() { return meta()?.workers; },
  };
}

/**
 * Resolve inference config for a named actor.
 */
export function resolveActorInference<T extends RoleInference>(
  config: { actors?: { [A in keyof ActorInferenceConfig]?: T } },
  actor: 'gatherer' | 'matcher'
): T {
  const specific = config.actors?.[actor];
  if (specific) return specific;

  throw new Error(
    `No inference config found for actor '${actor}'. ` +
    `Set actors.${actor}.inference in your config.`
  );
}

/**
 * Resolve inference config for a named worker type.
 * Falls back to workers.default if a specific worker is not listed.
 */
export function resolveWorkerInference<T extends RoleInference>(
  config: { workers?: { [R in keyof WorkerInferenceConfig]?: T } },
  workerType: keyof Omit<WorkerInferenceConfig, 'default'>
): T {
  const specific = config.workers?.[workerType];
  if (specific) return specific;

  const defaultWorker = config.workers?.default;
  if (defaultWorker) return defaultWorker;

  throw new Error(
    `No inference config found for worker '${workerType}'. ` +
    `Set workers.${workerType}.inference or workers.default.inference in your config.`
  );
}

/** One keyless role entry, refused by name when it is not a provider and a model. */
function roleInference(role: string, entry: { inference?: { type?: string; model?: string } }): [string, RoleInference][] {
  const { type, model } = entry.inference ?? {};
  if (type === undefined && model === undefined) return [];
  if ((type !== 'anthropic' && type !== 'ollama') || !model) {
    throw new Error(`${role}.inference must name type "anthropic" or "ollama" and a model (got type ${JSON.stringify(type)}, model ${JSON.stringify(model)})`);
  }
  return [[role, { type, model }]];
}

/**
 * The roster from the loaded config's keyless role maps, which select exactly
 * what the credentialed ones do and never read [inference]. Delegates at each
 * read, as `makeMeaningConfigFrom` does.
 */
export function rosterConfigFrom(config: EnvironmentConfig): RosterConfig {
  const roles = (maps: EnvironmentConfig['workers']) =>
    Object.fromEntries(Object.entries(maps ?? {}).flatMap(([role, entry]) => roleInference(role, entry)));
  return {
    get workers() { return roles(config.workers); },
    get actors() { return roles(config.actors); },
  };
}
