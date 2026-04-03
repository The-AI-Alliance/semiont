/**
 * TOML Config Loader
 *
 * Reads ~/.semiontconfig (TOML) and .semiont/config (TOML) and produces
 * an EnvironmentConfig for the requested environment.
 *
 * File format: see TOML-XDG-CONFIG.md
 *
 * Loading sequence:
 *   1. Read .semiont/config  → projectName, site, environments.<env>.* (project base)
 *   2. Read ~/.semiontconfig → defaults, environments.<env>.* (user overrides)
 *   3. Deep-merge: project base ← user overrides (user wins on conflicts)
 *      Any environment name is valid (local, staging, production, custom, ...)
 *   4. Resolve ${VAR} references from process.env
 *   5. Apply inheritance: workers.<name> → workers.default → error
 *   6. Map to EnvironmentConfig shape
 */

import { parse as parseToml } from 'smol-toml';
import type { EnvironmentConfig, OllamaProviderConfig, AnthropicProviderConfig } from './config.types';
import type { PlatformType } from './config.types';

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

function resolveEnvVars(obj: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      if (env[varName] === undefined) {
        throw new Error(`Environment variable ${varName} is not set (referenced in config as ${match})`);
      }
      return env[varName] as string;
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

interface SemiontConfigFile {
  user?: {
    name?: string;
    email?: string;
  };
  defaults?: {
    environment?: string;
    platform?: string;
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

interface EnvironmentSection {
  backend?: {
    platform?: string;
    port?: number;
    publicURL?: string;
    frontendURL?: string;
    corsOrigin?: string;
  };
  frontend?: {
    platform?: string;
    port?: number;
    publicURL?: string;
  };
  site?: {
    domain?: string;
    siteName?: string;
    adminEmail?: string;
    oauthAllowedDomains?: string[];
    enableLocalAuth?: boolean;
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
  inference?: InferenceFlatSection;
  'make-meaning'?: {
    graph?: Record<string, unknown>;
    actors?: {
      gatherer?: { inference?: InferenceConfig };
      matcher?: { inference?: InferenceConfig };
    };
    default?: { inference?: InferenceConfig };
  };
  workers?: Record<string, { inference?: InferenceConfig }>;
  actors?: Record<string, { inference?: InferenceConfig }>;
  logLevel?: 'error' | 'warn' | 'info' | 'http' | 'debug';
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
 * @param environment - Environment name (e.g. 'local', 'production')
 * @param globalConfigPath - Path to ~/.semiontconfig (caller resolves ~ expansion)
 * @param reader - File reader abstraction
 * @param env - Environment variables for ${VAR} resolution
 */
export function loadTomlConfig(
  projectRoot: string | null,
  environment: string,
  globalConfigPath: string,
  reader: TomlFileReader,
  env: Record<string, string | undefined>
): EnvironmentConfig {
  // 1. Read project config from .semiont/config (skipped when no project root)
  const projectConfigContent = projectRoot ? reader.readIfExists(`${projectRoot}/.semiont/config`) : null;
  let projectName = 'semiont-project';
  let projectVersion: string | undefined;
  let projectSite: EnvironmentSection['site'] | undefined;
  let projectEnvSection: EnvironmentSection = {};
  if (projectConfigContent) {
    const projectConfig = parseToml(projectConfigContent) as {
      project?: { name?: string; version?: string };
      site?: EnvironmentSection['site'];
      environments?: Record<string, EnvironmentSection>;
    };
    projectName = projectConfig.project?.name ?? projectName;
    projectVersion = projectConfig.project?.version;
    projectSite = projectConfig.site;
    projectEnvSection = projectConfig.environments?.[environment] ?? {};
  }

  // 2. Read global config (optional — missing config yields empty environments)
  const globalContent = reader.readIfExists(globalConfigPath);
  const raw = globalContent ? (parseToml(globalContent) as SemiontConfigFile) : ({} as SemiontConfigFile);

  // 3. Deep-merge: project base + user overrides (user wins on conflicts)
  const userEnvSection: EnvironmentSection = raw.environments?.[environment] ?? {};
  const envSection: EnvironmentSection = deepMerge(
    projectEnvSection as Record<string, unknown>,
    userEnvSection as Record<string, unknown>
  ) as EnvironmentSection;

  // 4. Resolve ${VAR} references
  const resolved = resolveEnvVars(envSection, env) as EnvironmentSection;

  // 5. Build make-meaning actor/worker inference config with inheritance
  // The flat [inference] section provides defaults (apiKey, maxTokens, endpoint/baseURL).
  // Actor/worker sections only need to specify type and model; missing fields fall back
  // to the flat inference section.
  const flatInference = resolved.inference;
  const makeMeaningSection = resolved['make-meaning'];
  const workersSection = resolved.workers ?? {};
  const actorsSection = resolved.actors ?? {};
  const defaultWorkerInference = workersSection['default']?.inference;
  const defaultMakeMeaningInference = makeMeaningSection?.default?.inference;

  function mergeWithFlatInference(specific: InferenceConfig): InferenceConfig {
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
            `[environments.${environment}.inference] is missing 'type'. ` +
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
            `[environments.${environment}.inference] is missing 'type'. ` +
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

  function resolveActorInference(fromMakeMeaning?: InferenceConfig, fromActors?: InferenceConfig): InferenceConfig | undefined {
    const base = fromMakeMeaning ?? fromActors ?? defaultMakeMeaningInference;
    if (!base) return undefined;
    return mergeWithFlatInference(base);
  }

  const actors: ActorInferenceConfig = {};
  const gathererInference = resolveActorInference(
    makeMeaningSection?.actors?.gatherer?.inference,
    actorsSection['gatherer']?.inference
  );
  if (gathererInference) actors.gatherer = gathererInference;

  const matcherInference = resolveActorInference(
    makeMeaningSection?.actors?.matcher?.inference,
    actorsSection['matcher']?.inference
  );
  if (matcherInference) actors.matcher = matcherInference;

  const workers: WorkerInferenceConfig = {};
  const workerTypes = ['reference-annotation', 'highlight-annotation', 'assessment-annotation', 'comment-annotation', 'tag-annotation', 'generation'] as const;
  if (defaultWorkerInference) {
    workers.default = mergeWithFlatInference(defaultWorkerInference);
  }
  for (const wt of workerTypes) {
    const specific = workersSection[wt]?.inference;
    if (specific) {
      (workers as Record<string, InferenceConfig>)[wt] = mergeWithFlatInference(specific);
    }
  }

  // 6. Map to EnvironmentConfig
  const backend = resolved.backend;
  const site = resolved.site ?? projectSite;
  const inferenceSection = resolved.inference;

  // Build inference providers config.
  // Supports two formats:
  //   Flat:  [environments.local.inference] type = "anthropic"|"ollama"  (single provider)
  //   Keyed: [environments.local.inference.anthropic] / [environments.local.inference.ollama] (multi-provider)
  let inferenceProviders: EnvironmentConfig['inference'] | undefined;
  if (inferenceSection) {
    inferenceProviders = {};
    // Keyed sub-sections take priority
    if (inferenceSection.anthropic) {
      const a = inferenceSection.anthropic;
      inferenceProviders.anthropic = {
        platform: requirePlatform(a.platform, 'inference.anthropic'),
        endpoint: a.endpoint ?? 'https://api.anthropic.com',
        apiKey: a.apiKey ?? '',
      } as AnthropicProviderConfig;
    } else if (inferenceSection.type === 'anthropic') {
      inferenceProviders.anthropic = {
        platform: requirePlatform(inferenceSection.platform, 'inference'),
        endpoint: inferenceSection.endpoint ?? 'https://api.anthropic.com',
        apiKey: inferenceSection.apiKey ?? '',
      } as AnthropicProviderConfig;
    }
    if (inferenceSection.ollama) {
      const o = inferenceSection.ollama;
      inferenceProviders.ollama = {
        platform: { type: requirePlatform(o.platform, 'inference.ollama') },
        baseURL: o.baseURL,
        port: o.baseURL ? undefined : (o.port ?? 11434),
      } as OllamaProviderConfig;
    } else if (inferenceSection.type === 'ollama') {
      inferenceProviders.ollama = {
        platform: { type: requirePlatform(inferenceSection.platform, 'inference') },
        baseURL: inferenceSection.baseURL,
        port: inferenceSection.baseURL ? undefined : 11434,
      } as OllamaProviderConfig;
    }
  }

  // Build top-level workers/actors maps for EnvironmentConfig
  const topLevelWorkers: EnvironmentConfig['workers'] = {};
  for (const [name, w] of Object.entries(workersSection)) {
    if (w.inference) {
      topLevelWorkers[name] = { inference: { type: w.inference.type, model: w.inference.model } };
    }
  }
  const topLevelActors: EnvironmentConfig['actors'] = {};
  for (const [name, a] of Object.entries(actorsSection)) {
    if (a.inference) {
      topLevelActors[name] = { inference: { type: a.inference.type, model: a.inference.model } };
    }
  }
  // Also include make-meaning actors
  if (makeMeaningSection?.actors?.gatherer?.inference) {
    topLevelActors['gatherer'] = { inference: { type: makeMeaningSection.actors.gatherer.inference.type, model: makeMeaningSection.actors.gatherer.inference.model } };
  }
  if (makeMeaningSection?.actors?.matcher?.inference) {
    topLevelActors['matcher'] = { inference: { type: makeMeaningSection.actors.matcher.inference.type, model: makeMeaningSection.actors.matcher.inference.model } };
  }

  const frontend = resolved.frontend;

  const services: EnvironmentConfig['services'] = {};

  if (backend) {
    services.backend = {
      platform: { type: requirePlatform(backend.platform, 'backend') },
      port: backend.port ?? 4000,
      publicURL: backend.publicURL ?? `http://localhost:${backend.port ?? 4000}`,
      corsOrigin: backend.corsOrigin ?? backend.frontendURL ?? 'http://localhost:3000',
    };
  }

  if (frontend) {
    services.frontend = {
      platform: { type: requirePlatform(frontend.platform, 'frontend') },
      port: frontend.port ?? 3000,
      siteName: site?.siteName ?? 'Semiont',
      publicURL: frontend.publicURL,
    };
  }

  if (resolved.graph) {
    services.graph = {
      ...resolved.graph,
      platform: { type: requirePlatform(resolved.graph.platform as string | undefined, 'graph') },
      type: (resolved.graph.type ?? 'neo4j') as import('./config.types').GraphDatabaseType,
    } as EnvironmentConfig['services']['graph'];
  } else if (makeMeaningSection?.graph) {
    services.graph = makeMeaningSection.graph as EnvironmentConfig['services']['graph'];
  }

  if (resolved.database) {
    services.database = {
      platform: { type: requirePlatform(resolved.database.platform, 'database') },
      type: 'postgres',
      image: resolved.database.image,
      host: resolved.database.host ?? 'localhost',
      port: resolved.database.port ?? 5432,
      name: resolved.database.name,
      user: resolved.database.user,
      password: resolved.database.password,
    } as EnvironmentConfig['services']['database'];
  }

  const config: EnvironmentConfig = {
    services,
    ...(inferenceProviders ? { inference: inferenceProviders } : {}),
    ...(Object.keys(topLevelWorkers).length > 0 ? { workers: topLevelWorkers } : {}),
    ...(Object.keys(topLevelActors).length > 0 ? { actors: topLevelActors } : {}),
    site: site ? {
      domain: site.domain ?? 'localhost',
      siteName: site.siteName,
      adminEmail: site.adminEmail,
      oauthAllowedDomains: site.oauthAllowedDomains as [string, ...string[]] | undefined,
    } : undefined,
    logLevel: resolved.logLevel,
    _metadata: {
      environment,
      projectRoot,
      projectName,
      projectVersion,
      ...(Object.keys(actors).length > 0 ? { actors } : {}),
      ...(Object.keys(workers).length > 0 ? { workers } : {}),
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
  env: Record<string, string | undefined>
) {
  return (projectRoot: string | null, environment: string): EnvironmentConfig => {
    return loadTomlConfig(projectRoot, environment, globalConfigPath, reader, env);
  };
}
