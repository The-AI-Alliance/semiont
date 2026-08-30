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

/** Narrow config type — only the fields make-meaning actually reads */
export interface MakeMeaningConfig {
  /**
   * Resource-gather policy. `settleTimeoutMs` bounds the semanticContext
   * read-your-writes barrier (SMELTER-INDEX-SYNC D3/D5) — REQUIRED: the TOML
   * loader owns the one default (15s at `[environments.<env>.make-meaning.gather]`);
   * hand-built configs (scripts, tests) state their policy explicitly. Must
   * nest inside downstream watchdogs (A4).
   */
  gather: { settleTimeoutMs: number };
  /**
   * Search policy. `semanticFloor` is the minimum cosine score a vector hit
   * needs to appear in the semantic fallback (SEMANTIC-FALLBACK decision #1)
   * — REQUIRED: the TOML loader owns the one default (0.6 at
   * `[environments.<env>.make-meaning.search]`); hand-built configs
   * (scripts, tests) state their policy explicitly.
   */
  search: { semanticFloor: number };
  services: {
    graph?: GraphServiceConfig;
    /** REQUIRED (MANDATORY-EMBEDDING D0+D1, type-level per the 2026-08-12
     *  ruling): the config NAMES its store — `memory` is a first-class
     *  explicit choice, never a fallback. The TOML loader refuses configs
     *  without it; the type makes hand-built configs state their choice. */
    vectors: VectorsServiceConfig;
    /** REQUIRED (same ruling): the embedding provider is the KB's semantic
     *  identity — always named, never detected or defaulted. */
    embedding: EmbeddingServiceConfig;
    /** Where the record is. Optional in the type because the actors that
     *  hold a KB mount never dial it; the Librarian does, and refuses at
     *  boot when it is absent (SINGLE-KB-MOUNT P4). */
    archivist?: ArchivistServiceConfig;
  };
  /**
   * The KB's canonical identity domain — the SAME value `/api/tokens/agent`
   * mints agent DIDs from (backend `site.domain`). The agent roster consumes
   * it verbatim, so directory DIDs and work-stamped `generator` DIDs are
   * equal by construction; it is never derived from service topology
   * (.plans/bugs/agent-did-host-skew.md).
   */
  site?: { domain: string };
  /** Per-actor inference config */
  actors?: ActorInferenceConfig;
  /** Per-worker-type inference config */
  workers?: WorkerInferenceConfig;
}

/**
 * Extract the MakeMeaningConfig slice from a full EnvironmentConfig.
 * actors and workers come from _metadata (populated by the TOML loader).
 *
 * Lives here (not in a consumer) because every composition root that runs
 * make-meaning actors — the gateway's startMakeMeaning and the Archivist's
 * archivist-main — needs the identical mapping; two copies would drift.
 */
/**
 * The KB name a mountless service composes its state paths from —
 * `[kb] name`, staged by the launcher (SINGLE-KB-MOUNT D4). Refusing is the
 * point: a defaulted name composes a state path nobody writes to, and the
 * service reads an empty view store forever, silently.
 */
export function requireKBName(config: EnvironmentConfig): string {
  const name = config.kb?.name;
  if (!name) {
    throw new Error(
      '[kb] name is missing from the environment config. The launcher stages the ' +
        "KB's committed identity into each service's config (SINGLE-KB-MOUNT D4); " +
        'without it this service cannot locate the state tree.',
    );
  }
  return name;
}

export function makeMeaningConfigFrom(config: EnvironmentConfig): MakeMeaningConfig {
  const meta = config._metadata as (EnvironmentConfig['_metadata'] & {
    actors?: MakeMeaningConfig['actors'];
    workers?: MakeMeaningConfig['workers'];
    gather?: MakeMeaningConfig['gather'];
    search?: MakeMeaningConfig['search'];
  }) | undefined;

  // The TOML loader always sets _metadata.gather (it owns the one default —
  // D5). A missing value means this config bypassed the loader: fail loudly
  // rather than default here.
  const gather = meta?.gather;
  if (!gather) {
    throw new Error('make-meaning gather config missing — load config via loadEnvironmentConfig (the TOML loader owns the settleTimeoutMs default)');
  }
  const search = meta?.search;
  if (!search) {
    throw new Error('make-meaning search config missing — load config via loadEnvironmentConfig (the TOML loader owns the semanticFloor default)');
  }

  return {
    gather,
    search,
    services: {
      // vectors/embedding are required on both sides (MANDATORY-EMBEDDING P3):
      // core's ServicesConfig requires the pair, so a config missing either
      // already refused at the TOML loader — nothing to re-check here.
      graph: config.services.graph,
      vectors: config.services.vectors,
      embedding: config.services.embedding,
      archivist: config.services.archivist,
    },
    // The KB's canonical identity — the agent roster mints DIDs from this,
    // the SAME value /api/tokens/agent uses (agent-did-host-skew fix). The
    // value, not JWTService, so make-meaning stays backend-agnostic.
    ...(config.site?.domain ? { site: { domain: config.site.domain } } : {}),
    actors: meta?.actors,
    workers: meta?.workers,
  };
}

/**
 * Resolve inference config for a named actor.
 */
export function resolveActorInference(
  config: MakeMeaningConfig,
  actor: 'gatherer' | 'matcher'
): InferenceConfig {
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
export function resolveWorkerInference(
  config: MakeMeaningConfig,
  workerType: keyof Omit<WorkerInferenceConfig, 'default'>
): InferenceConfig {
  const specific = config.workers?.[workerType];
  if (specific) return specific;

  const defaultWorker = config.workers?.default;
  if (defaultWorker) return defaultWorker;

  throw new Error(
    `No inference config found for worker '${workerType}'. ` +
    `Set workers.${workerType}.inference or workers.default.inference in your config.`
  );
}
