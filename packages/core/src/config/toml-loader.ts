/**
 * TOML Config Loader
 *
 * Reads ~/.semiontconfig (TOML) and .semiont/config (TOML) and produces
 * an EnvironmentConfig for the requested environment.
 *
 * File format: see docs/operator/administration/CONFIGURATION.md
 *
 * Loading sequence:
 *   1. Read .semiont/config  → environments.<env>.* (project base)
 *   2. Read ~/.semiontconfig → defaults, environments.<env>.* (user overrides)
 *   3. Deep-merge: project base ← user overrides (user wins on conflicts)
 *      Any environment name is valid (local, staging, production, custom, ...)
 *   4. Resolve a section's ${VAR} references from process.env when it is read
 *   5. Apply inheritance: workers.<name> → workers.default → error
 *   6. Map to EnvironmentConfig shape, each part built at its first read
 */

import { parse as parseToml } from 'smol-toml';
import type { EnvironmentConfig, OllamaProviderConfig, AnthropicProviderConfig } from './config.types';
import type { PlatformType } from './config.types';
import { serviceConfigSections, type ConfigService } from '../generated/service-config-sections';

/**
 * Deep merge two plain objects. Arrays and primitives in `override` replace those in `base`.
 * Nested objects are merged recursively. `override` takes precedence on conflicts.
 */
function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(override)) {
    const b = base[key];
    const o = override[key];
    if (o !== undefined && o !== null && typeof o === 'object' && !Array.isArray(o) &&
        b !== undefined && b !== null && typeof b === 'object' && !Array.isArray(b)) {
      result[key] = deepMerge(b as Record<string, unknown>, o as Record<string, unknown>);
    } else if (o !== undefined) {
      result[key] = o;
    }
  }
  return result as T;
}

/**
 * Every ${VAR} and ${VAR:-default} in a parsed config, resolved against
 * `env`. The rule is shared with the Go launcher, which resolves the
 * gateway's configuration document by it; both run
 * specs/src/config-placeholders/cases.json.
 */
export function resolveEnvVars(obj: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (match, expr: string) => {
      const sepIdx = expr.indexOf(':-');
      const varName = sepIdx >= 0 ? expr.slice(0, sepIdx) : expr;
      const defaultValue = sepIdx >= 0 ? expr.slice(sepIdx + 2) : undefined;
      const value = env[varName];
      if (value !== undefined) return value;
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Environment variable ${varName} is not set (referenced in config as ${match})`);
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(item => resolveEnvVars(item, env));
  }
  if (obj !== null && typeof obj === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const key in obj as Record<string, unknown>) {
      resolved[key] = resolveEnvVars((obj as Record<string, unknown>)[key], env);
    }
    return resolved;
  }
  return obj;
}

// ── Inference config types (mirrored from packages/make-meaning/src/config.ts) ─
// Kept here to avoid a circular dependency: core cannot import make-meaning.

export interface InferenceConfig {
  type: 'anthropic' | 'ollama';
  model: string;
  maxTokens?: number;
  apiKey?: string;
  endpoint?: string;
  baseURL?: string;
}

export interface ActorInferenceConfig {
  gatherer?: InferenceConfig;
  matcher?: InferenceConfig;
}

export interface WorkerInferenceConfig {
  default?: InferenceConfig;
  'reference-annotation'?: InferenceConfig;
  'highlight-annotation'?: InferenceConfig;
  'assessment-annotation'?: InferenceConfig;
  'comment-annotation'?: InferenceConfig;
  'tag-annotation'?: InferenceConfig;
  'generation'?: InferenceConfig;
}

// ── Types for ~/.semiontconfig ────────────────────────────────────────────────

/** The archivist's default port — the ONE home; node-config-loader imports it. */
export const DEFAULT_ARCHIVIST_PORT = 24103;

interface SemiontConfigFile {
  user?: {
    name?: string;
    email?: string;
  };
  defaults?: {
    environment?: string;
    platform?: string;
  };
  // The KB's committed identity — `[site] domain` and `[project] name` from its
  // .semiont/config — staged by the launcher for the services that do not
  // mount the tree. Top-level, beside [defaults], where no environment section
  // reaches it.
  kb?: {
    name?: string;
    domain?: string;
  };
  environments?: Record<string, EnvironmentSection>;
}

interface GraphSection {
  platform?: string;
  type?: string;
  name?: string;
  uri?: string;
  username?: string;
  password?: string;
  database?: string;
  [key: string]: unknown;
}

interface InferenceFlatSection {
  // Flat (single-provider) format: type = "anthropic"|"ollama" at this level
  type?: 'anthropic' | 'ollama';
  platform?: string;
  model?: string;
  maxTokens?: number;
  apiKey?: string;
  endpoint?: string;
  baseURL?: string;
  // Keyed (multi-provider) format: [inference.anthropic] / [inference.ollama]
  anthropic?: { platform?: string; apiKey?: string; endpoint?: string };
  ollama?: { platform?: string; baseURL?: string; port?: number };
}

interface GatewaySection {
  platform?: string;
  port?: number;
  publicURL?: string;
}

interface EnvironmentSection {
  gateway?: GatewaySection;
  /**
   * The pre-rename spelling of `gateway`. Accepted so the KB fleet — whose
   * TOMLs live in repos this build cannot reach — keeps loading across the
   * rename. Retires when every fleet repo says `gateway`; that trigger is a
   * release-checklist item, not something CI here can observe.
   */
  backend?: GatewaySection;
  archivist?: {
    host?: string;
    port?: number;
  };
  identity?: {
    type?: 'keycloak' | 'oidc';
    issuer?: string;
    subjectClaim?: string;
  };
  database?: {
    platform?: string;
    image?: string;
    host?: string;
    port?: number;
    name?: string;
    user?: string;
    password?: string;
  };
  graph?: GraphSection;
  vectors?: {
    type?: 'qdrant' | 'memory';
    host?: string;
    port?: number;
    // Legacy: embedding nested under vectors (migrated to top-level)
    embedding?: {
      type?: 'voyage' | 'ollama';
      model?: string;
      apiKey?: string;
      baseURL?: string;
      endpoint?: string;
    };
    chunking?: {
      chunkSize?: number;
      overlap?: number;
    };
  };
  embedding?: {
    type?: 'voyage' | 'ollama';
    model?: string;
    apiKey?: string;
    baseURL?: string;
    endpoint?: string;
    chunking?: {
      chunkSize?: number;
      overlap?: number;
    };
  };
  inference?: InferenceFlatSection;
  'make-meaning'?: {
    graph?: Record<string, unknown>;
    actors?: {
      gatherer?: { inference?: InferenceConfig };
      matcher?: { inference?: InferenceConfig };
    };
    default?: { inference?: InferenceConfig };
    /**
     * Resource-gather knobs. `settleTimeoutMs` bounds the semanticContext
     * read-your-writes barrier — how long a gather waits for the vector
     * projection to settle before degrading to an absent semanticContext.
     * Must nest INSIDE downstream watchdogs (job-worker liveness, client
     * stall watchdogs): the gather's worst-case barrier spend has to stay
     * below each of them.
     */
    gather?: { settleTimeoutMs?: number };
    /**
     * Search knobs. `semanticFloor` is the minimum cosine score a vector hit
     * needs to appear in the semantic fallback — fired only when a lexical
     * search returns nothing. The loader is the ONE home of the default: 0.6,
     * midway between the Matcher's recall-oriented 0.4 (which feeds a
     * composite scorer) and a precision-strict 0.8 — a guess to be tuned from
     * the fallback's own score-distribution debug line, revisable here in one
     * line.
     */
    search?: { semanticFloor?: number };
  };
  workers?: Record<string, { inference?: InferenceConfig }>;
  actors?: Record<string, { inference?: InferenceConfig }>;
}

// ── File reader abstraction (same pattern as createConfigLoader) ──────────────

export type TomlFileReader = {
  readIfExists: (path: string) => string | null;
};

function requirePlatform(value: string | undefined, serviceName: string): PlatformType {
  if (!value) {
    throw new Error(`platform is required for service '${serviceName}' — add 'platform = "posix"|"container"|"external"' to its config section`);
  }
  return value as PlatformType;
}

// ── Main loader function ──────────────────────────────────────────────────────

/**
 * Parse ~/.semiontconfig and .semiont/config and return EnvironmentConfig.
 *
 * @param projectRoot - Path to the project root (contains .semiont/config)
 * @param environment - Environment name (e.g. 'local', 'production'); when
 *   undefined, resolved from `[defaults] environment`
 * @param globalConfigPath - Path to ~/.semiontconfig (caller resolves ~ expansion)
 * @param reader - File reader abstraction
 * @param env - Environment variables for ${VAR} resolution
 * @param service - The Node service loading it, which may read only the
 *   sections specs/src/service-config/sections.json lists for it; absent for
 *   tools that read any section
 */
export function loadTomlConfig(
  projectRoot: string | null,
  environment: string | undefined,
  globalConfigPath: string,
  reader: TomlFileReader,
  env: Record<string, string | undefined>,
  service?: ConfigService,
): EnvironmentConfig {
  // 1. Read + parse project config from .semiont/config (skipped when no project root)
  const projectConfigContent = projectRoot ? reader.readIfExists(`${projectRoot}/.semiont/config`) : null;
  const projectConfig = projectConfigContent
    ? (parseToml(projectConfigContent) as {
        environments?: Record<string, EnvironmentSection>;
      })
    : undefined;

  // 2. Read global config (optional — missing config yields empty environments)
  const globalContent = reader.readIfExists(globalConfigPath);
  const raw = globalContent ? (parseToml(globalContent) as SemiontConfigFile) : ({} as SemiontConfigFile);

  // 3. Resolve WHICH environment to load. `[defaults] environment` is the key the
  //    launcher selects from (config.go: cfg.Defaults.Environment); the gateway
  //    resolves from the SAME key so one config selects the environment for both
  //    halves. TWO inputs only — an explicit argument (tests pass one) and the
  //    committed config — and they cannot contradict each other, because the
  //    explicit one is legible at the call site. There is deliberately NO ambient
  //    environment variable in this chain: `SEMIONT_ENV` was removed because an
  //    invisible input that can disagree with the staged config is precisely the
  //    bug shape #1108 fixed. And no silent 'local'/'development' fallback — an
  //    unselected environment is a config error, not a default.
  const resolvedEnvironment = environment ?? raw.defaults?.environment;
  if (!resolvedEnvironment) {
    throw new Error(
      'No environment selected: pass one explicitly, or declare ' +
        '`[defaults] environment` in ~/.semiontconfig.',
    );
  }

  // 4. A named environment with no [environments.X] section ANYWHERE is a config
  //    error, not a silent empty {}. The silent {} is what let a KB declaring
  //    `environment = "staging"` (with no [environments.staging]) load nothing and
  //    let every downstream default fire, back when a domain-less [site]
  //    still resolved to 'localhost',
  //    the fabricated colliding did:web:localhost identity. Fail loud instead.
  const projectHasSection =
    projectConfig?.environments != null && resolvedEnvironment in projectConfig.environments;
  const globalHasSection = raw.environments != null && resolvedEnvironment in raw.environments;
  if (!projectHasSection && !globalHasSection) {
    throw new Error(
      `Environment "${resolvedEnvironment}" is selected but no [environments.${resolvedEnvironment}] ` +
        'section exists in the project (.semiont/config) or global (~/.semiontconfig) config. ' +
        'Declare the section, or select an environment that exists.',
    );
  }

  // A knowledge base declares its identity once: `[site]`, at the top level of
  // its committed .semiont/config, read there by SemiontProject and the
  // launcher and by nothing here. An environment-scoped [site] used to replace
  // that table whole, domain included; nothing may override a KB's identity.
  const scopedSites = [
    ...Object.entries(projectConfig?.environments ?? {}).map(([name, section]) => ({ name, section, file: `${projectRoot}/.semiont/config` })),
    ...Object.entries(raw.environments ?? {}).map(([name, section]) => ({ name, section, file: globalConfigPath })),
  ].filter(({ section }) => 'site' in section);
  if (scopedSites.length > 0) {
    throw new Error(
      scopedSites.map(({ name, file }) => `[environments.${name}.site] in ${file}`).join(', ') +
        ': a knowledge base declares [site] once, at the top level of its committed .semiont/config, ' +
        'and no environment can override it. Delete the section.',
    );
  }

  // 5. Deep-merge: project base + user overrides (user wins on conflicts)
  const projectEnvSection: EnvironmentSection = projectConfig?.environments?.[resolvedEnvironment] ?? {};
  const userEnvSection: EnvironmentSection = raw.environments?.[resolvedEnvironment] ?? {};
  const envSection: EnvironmentSection = deepMerge(
    projectEnvSection as Record<string, unknown>,
    userEnvSection as Record<string, unknown>
  ) as EnvironmentSection;

  // 6. Each section resolves when it is read, and a service reads only the
  //    sections specs/src/service-config/sections.json lists for it. An unset
  //    ${VAR} therefore refuses at the first read of the section that names
  //    it — never for a section this process never reads — and the launcher
  //    can forward each service only its sections' variables.
  const declared: readonly string[] | undefined = service ? serviceConfigSections[service] : undefined;
  const resolvedSections = new Map<keyof EnvironmentSection, unknown>();
  function section<K extends keyof EnvironmentSection>(key: K): EnvironmentSection[K] {
    const listed = key === 'backend' ? 'gateway' : key;
    if (declared && !declared.includes(listed)) {
      throw new Error(
        `${service} read [environments.${resolvedEnvironment}.${key}], which specs/src/service-config/sections.json ` +
          `does not list for it. List the section there if ${service} needs it: the launcher forwards each service ` +
          'only the variables its listed sections reference.',
      );
    }
    if (!resolvedSections.has(key)) resolvedSections.set(key, resolveEnvVars(envSection[key], env));
    return resolvedSections.get(key) as EnvironmentSection[K];
  }
  const built = new Map<string, unknown>();
  function once<T>(part: string, build: () => T): T {
    if (!built.has(part)) built.set(part, build());
    return built.get(part) as T;
  }

  // 7. Make-meaning actor/worker inference with inheritance. The flat
  // [inference] section provides defaults (apiKey, maxTokens, endpoint/baseURL).
  // Actor/worker sections only need to specify type and model; missing fields
  // fall back to the flat inference section.
  function mergeWithFlatInference(specific: InferenceConfig): InferenceConfig {
    const flatInference = section('inference');
    if (!flatInference) return specific;
    // For keyed sub-sections, inherit credentials from the matching provider sub-section.
    // For flat (legacy) format, flatInference.type is required to know which fields apply.
    const providerDefaults: Partial<InferenceConfig> = {};
    if (specific.type === 'anthropic') {
      const a = flatInference.anthropic;
      if (a) {
        providerDefaults.apiKey = a.apiKey;
        providerDefaults.endpoint = a.endpoint;
      } else {
        if (!flatInference.type) {
          throw new Error(
            `[environments.${resolvedEnvironment}.inference] is missing 'type'. ` +
            `Add type = "anthropic" or use [inference.anthropic] sub-section.`
          );
        }
        providerDefaults.apiKey = flatInference.apiKey;
        providerDefaults.endpoint = flatInference.endpoint;
      }
    } else if (specific.type === 'ollama') {
      const o = flatInference.ollama;
      if (o) {
        providerDefaults.baseURL = o.baseURL;
      } else {
        if (!flatInference.type) {
          throw new Error(
            `[environments.${resolvedEnvironment}.inference] is missing 'type'. ` +
            `Add type = "ollama" or use [inference.ollama] sub-section.`
          );
        }
        providerDefaults.baseURL = flatInference.baseURL;
      }
    }
    return {
      maxTokens: flatInference.maxTokens,
      ...providerDefaults,
      ...specific,
    };
  }

  // Which section serves each role is decided once, here, and read twice:
  // keyless, as the roster (`workers`/`actors`: who serves a role, which the
  // archivist lists without holding any credential), and merged with
  // [inference], as the services that call the model need it
  // (`_metadata.workers`/`_metadata.actors`).
  function selectedActors(): [keyof ActorInferenceConfig, InferenceConfig][] {
    const makeMeaningSection = section('make-meaning');
    const actorsSection = section('actors') ?? {};
    const selected: [keyof ActorInferenceConfig, InferenceConfig][] = [];
    for (const actor of ['gatherer', 'matcher'] as const) {
      const inference = makeMeaningSection?.actors?.[actor]?.inference
        ?? actorsSection[actor]?.inference
        ?? makeMeaningSection?.default?.inference;
      if (inference) selected.push([actor, inference]);
    }
    return selected;
  }

  function selectedWorkers(): [keyof WorkerInferenceConfig, InferenceConfig][] {
    const workersSection = section('workers') ?? {};
    const roles = ['default', 'reference-annotation', 'highlight-annotation', 'assessment-annotation', 'comment-annotation', 'tag-annotation', 'generation'] as const;
    return roles.flatMap((role) => {
      const inference = workersSection[role]?.inference;
      return inference ? [[role, inference] as [keyof WorkerInferenceConfig, InferenceConfig]] : [];
    });
  }

  function actorInference(): ActorInferenceConfig | undefined {
    const selected = selectedActors();
    return selected.length > 0
      ? Object.fromEntries(selected.map(([actor, inference]) => [actor, mergeWithFlatInference(inference)]))
      : undefined;
  }

  function workerInference(): WorkerInferenceConfig | undefined {
    const selected = selectedWorkers();
    return selected.length > 0
      ? Object.fromEntries(selected.map(([role, inference]) => [role, mergeWithFlatInference(inference)]))
      : undefined;
  }

  // Inference providers. Two formats:
  //   Flat:  [environments.local.inference] type = "anthropic"|"ollama"  (single provider)
  //   Keyed: [environments.local.inference.anthropic] / [environments.local.inference.ollama] (multi-provider)
  function inferenceProviders(): EnvironmentConfig['inference'] | undefined {
    const inferenceSection = section('inference');
    if (!inferenceSection) return undefined;
    const providers: NonNullable<EnvironmentConfig['inference']> = {};
    // Keyed sub-sections take priority
    if (inferenceSection.anthropic) {
      const a = inferenceSection.anthropic;
      providers.anthropic = {
        platform: requirePlatform(a.platform, 'inference.anthropic'),
        endpoint: a.endpoint ?? 'https://api.anthropic.com',
        apiKey: a.apiKey ?? '',
      } as AnthropicProviderConfig;
    } else if (inferenceSection.type === 'anthropic') {
      providers.anthropic = {
        platform: requirePlatform(inferenceSection.platform, 'inference'),
        endpoint: inferenceSection.endpoint ?? 'https://api.anthropic.com',
        apiKey: inferenceSection.apiKey ?? '',
      } as AnthropicProviderConfig;
    }
    if (inferenceSection.ollama) {
      const o = inferenceSection.ollama;
      providers.ollama = {
        platform: { type: requirePlatform(o.platform, 'inference.ollama') },
        baseURL: o.baseURL,
        port: o.baseURL ? undefined : (o.port ?? 11434),
      } as OllamaProviderConfig;
    } else if (inferenceSection.type === 'ollama') {
      providers.ollama = {
        platform: { type: requirePlatform(inferenceSection.platform, 'inference') },
        baseURL: inferenceSection.baseURL,
        port: inferenceSection.baseURL ? undefined : 11434,
      } as OllamaProviderConfig;
    }
    return providers;
  }

  // The roster: each role's provider and model, and no credential.
  function keyless(selected: [string, InferenceConfig][]): Record<string, { inference: { type: InferenceConfig['type']; model: string } }> | undefined {
    return selected.length > 0
      ? Object.fromEntries(selected.map(([role, i]) => [role, { inference: { type: i.type, model: i.model } }]))
      : undefined;
  }
  function topLevelWorkers(): EnvironmentConfig['workers'] | undefined {
    return keyless(selectedWorkers());
  }
  function topLevelActors(): EnvironmentConfig['actors'] | undefined {
    return keyless(selectedActors());
  }

  // 8. Map to EnvironmentConfig. Every part is built at its first read, and
  // every refusal a part owns fires there.

  // Semantic search is always available, so a config must NAME both a vector
  // store and an embedding provider — nothing is defaulted, and absence
  // refuses with a config-actionable message (explicit opt-in; `memory` is a
  // first-class choice, not a fallback).
  function vectors(): EnvironmentConfig['services']['vectors'] {
    const v = section('vectors');
    if (!v?.type) {
      throw new Error(
        `[environments.${resolvedEnvironment}] names no vector store — add [environments.${resolvedEnvironment}.vectors] with type = "qdrant" or "memory". Semiont requires a vector store; nothing is defaulted.`,
      );
    }
    return {
      platform: { type: 'external' as PlatformType },
      type: v.type,
      host: v.host,
      port: v.port ?? 6333,
    } as EnvironmentConfig['services']['vectors'];
  }

  function embedding(): EnvironmentConfig['services']['embedding'] {
    const e = section('embedding');
    const source = e ?? section('vectors')?.embedding;
    if (!source?.type || !source.model) {
      throw new Error(
        `[environments.${resolvedEnvironment}] names no embedding provider — add [environments.${resolvedEnvironment}.embedding] with type = "voyage" or "ollama" and a model. Semiont requires an embedding provider; nothing is defaulted.`,
      );
    }
    const chunking = e?.chunking ?? section('vectors')?.chunking;
    return {
      platform: { type: 'external' as PlatformType },
      type: source.type,
      model: source.model,
      apiKey: source.apiKey,
      baseURL: source.baseURL,
      endpoint: source.endpoint,
      chunking: chunking ? {
        chunkSize: chunking.chunkSize ?? 512,
        overlap: chunking.overlap ?? 64,
      } : undefined,
    } as EnvironmentConfig['services']['embedding'];
  }

  // MANDATORY (user, 2026-09-21). A knowledge base without a trusted issuer
  // can authenticate nobody: no person, because there are no keys to verify
  // against; no sidecar, because `authorizeAgentMinter` refuses before it
  // mints; and it cannot reach its own record, because dialling the Archivist
  // needs a service-account token.
  function identity(): EnvironmentConfig['services']['identity'] {
    const id = section('identity');
    if (!id) {
      throw new Error(
        `[environments.${resolvedEnvironment}] names no identity section — add [environments.${resolvedEnvironment}.identity] with type and issuer. Every knowledge base trusts an issuer: without one nobody can sign in, no sidecar can obtain an agent token, and the gateway cannot reach the Archivist.`,
      );
    }
    if (!id.type) {
      throw new Error(
        `[environments.${resolvedEnvironment}.identity] names no type — add type = "keycloak" or "oidc". Semiont selects the identity provider from config; nothing is inferred.`,
      );
    }
    if (!id.issuer) {
      throw new Error(
        `[environments.${resolvedEnvironment}.identity] names no issuer — add issuer = "http://\${KEYCLOAK_HOST}:8080/realms/semiont" (the URL in a token's iss claim). A typed-but-incomplete section never falls through.`,
      );
    }
    // A person's DID is did:web:<site domain>:users:<the value of this claim>.
    // Which claim is declared here — one rule per deployment, never a fallback
    // chain, never one code infers.
    if (!id.subjectClaim) {
      throw new Error(
        `[environments.${resolvedEnvironment}.identity] names no subjectClaim — add subjectClaim = "sub" (the issuer claim a person's DID is built from: did:web:<site domain>:users:<its value>). The claim people are named by is declared, never defaulted.`,
      );
    }
    return { type: id.type, issuer: id.issuer, subjectClaim: id.subjectClaim } as EnvironmentConfig['services']['identity'];
  }

  // `gateway` is the current spelling; `backend` is the pre-rename one, still
  // accepted for the fleet. A file carrying BOTH is half-migrated — a mistake
  // someone just made, not a state worth supporting — so it fails loudly
  // instead of picking a winner the next reader cannot identify.
  function gateway(): EnvironmentConfig['services']['gateway'] {
    const current = section('gateway');
    const legacy = section('backend');
    if (current && legacy) {
      throw new Error(
        `Environment '${resolvedEnvironment}' declares both [gateway] and [backend]. ` +
        `They are one section under two spellings; keep [gateway] and delete [backend].`
      );
    }
    const g = current ?? legacy;
    if (!g) return undefined;
    return {
      platform: { type: requirePlatform(g.platform, 'gateway') },
      port: g.port ?? 4000,
      publicURL: g.publicURL ?? `http://localhost:${g.port ?? 4000}`,
    };
  }

  // The Archivist's sequence-ranged event read path, which the gateway
  // replays SSE resumes from. Internal host:port like vectors — never a
  // publicURL; the Archivist is not public. Without this mapping the section
  // parses and then VANISHES, and every resume silently degrades to a gap.
  function archivist(): EnvironmentConfig['services']['archivist'] {
    const a = section('archivist');
    if (!a?.host) return undefined;
    return {
      platform: { type: 'external' as PlatformType },
      host: a.host,
      port: a.port ?? DEFAULT_ARCHIVIST_PORT,
    } as EnvironmentConfig['services']['archivist'];
  }

  function graph(): EnvironmentConfig['services']['graph'] {
    const g = section('graph');
    if (g) {
      return {
        ...g,
        platform: { type: requirePlatform(g.platform as string | undefined, 'graph') },
        type: (g.type ?? 'neo4j') as import('./config.types').GraphDatabaseType,
      } as EnvironmentConfig['services']['graph'];
    }
    return section('make-meaning')?.graph as EnvironmentConfig['services']['graph'];
  }

  function database(): EnvironmentConfig['services']['database'] {
    const d = section('database');
    if (!d) return undefined;
    return {
      platform: { type: requirePlatform(d.platform, 'database') },
      type: 'postgres',
      image: d.image,
      host: d.host ?? 'localhost',
      port: d.port ?? 5432,
      name: d.name,
      user: d.user,
      password: d.password,
    } as EnvironmentConfig['services']['database'];
  }

  // No browser service is emitted. The Browser is machine-level — one Browser
  // serves many KBs — so a KB neither knows nor affects its port or
  // publicURL. `[browser]` and the older `[frontend]` are inert unknown
  // sections: tolerated, never read, never refused. `[jobs]` is the
  // launcher's alone — it writes the dispatcher's queue settings from it — so
  // it is inert here too.
  const services: EnvironmentConfig['services'] = {
    get identity() { return once('identity', identity); },
    get vectors() { return once('vectors', vectors); },
    get embedding() { return once('embedding', embedding); },
    get gateway() { return once('gateway', gateway); },
    get archivist() { return once('archivist', archivist); },
    get graph() { return once('graph', graph); },
    get database() { return once('database', database); },
  };

  const config: EnvironmentConfig = {
    services,
    // From the GLOBAL file's root only — an [environments.X.kb] section is
    // inert by construction, which is what "not overridable" means here.
    ...(raw.kb?.name
      ? { kb: {
          name: raw.kb.name,
          ...(raw.kb.domain ? { domain: raw.kb.domain } : {}),
        } }
      : {}),
    get inference() { return once('inference', inferenceProviders); },
    get workers() { return once('workers', topLevelWorkers); },
    get actors() { return once('actors', topLevelActors); },
    _metadata: {
      environment: resolvedEnvironment,
      projectRoot,
      get actors() { return once('_metadata.actors', actorInference); },
      get workers() { return once('_metadata.workers', workerInference); },
      // The loader is the ONE home of these defaults. Consuming code
      // (make-meaning's gather path) receives a required value and defaults
      // nothing.
      get gather() { return once('_metadata.gather', () => ({ settleTimeoutMs: section('make-meaning')?.gather?.settleTimeoutMs ?? 15_000 })); },
      get search() { return once('_metadata.search', () => ({ semanticFloor: section('make-meaning')?.search?.semanticFloor ?? 0.6 })); },
    },
  };

  return config;
}

/**
 * Create a TOML config loader backed by a file reader.
 * Drop-in replacement for createConfigLoader that reads TOML instead of JSON.
 * The caller must resolve globalConfigPath (e.g. expand '~' using process.env.HOME).
 */
export function createTomlConfigLoader(
  reader: TomlFileReader,
  globalConfigPath: string,
  env: Record<string, string | undefined>,
  service?: ConfigService,
) {
  return (projectRoot: string | null, environment?: string): EnvironmentConfig => {
    return loadTomlConfig(projectRoot, environment, globalConfigPath, reader, env, service);
  };
}
