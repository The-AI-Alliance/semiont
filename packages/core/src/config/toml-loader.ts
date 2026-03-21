/**
 * TOML Config Loader
 *
 * Reads ~/.semiontconfig (TOML) and .semiont/config (TOML) and produces
 * an EnvironmentConfig for the requested environment.
 *
 * File format: see TOML-XDG-CONFIG.md
 *
 * Loading sequence:
 *   1. Read .semiont/config  → projectName
 *   2. Read ~/.semiontconfig → defaults, environments[env].*
 *   3. Resolve ${VAR} references from process.env
 *   4. Apply inheritance: workers.<name> → workers.default → error
 *   5. Map to EnvironmentConfig shape
 */

import { parse as parseToml } from 'smol-toml';
import type { EnvironmentConfig, OllamaProviderConfig, AnthropicProviderConfig } from './config.types';
import type { PlatformType } from './config.types';

function resolveEnvVars(obj: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => env[varName] ?? match);
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

interface EnvironmentSection {
  backend?: {
    port?: number;
    publicURL?: string;
    frontendURL?: string;
    corsOrigin?: string;
  };
  site?: {
    domain?: string;
    siteName?: string;
    adminEmail?: string;
    oauthAllowedDomains?: string[];
    enableLocalAuth?: boolean;
  };
  database?: {
    host?: string;
    port?: number;
    name?: string;
    user?: string;
    password?: string;
  };
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
  inference?: {
    ollama?: {
      platform?: string;
      baseURL?: string;
      port?: number;
      image?: string;
      command?: string;
      timeout?: number;
      wait?: number;
      logsEndpoint?: string;
    };
    anthropic?: {
      platform?: string;
      endpoint?: string;
      apiKey?: string;
    };
    [key: string]: unknown;
  };
  logLevel?: 'error' | 'warn' | 'info' | 'http' | 'debug';
}

// ── File reader abstraction (same pattern as createConfigLoader) ──────────────

export type TomlFileReader = {
  readIfExists: (path: string) => string | null;
};

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
  projectRoot: string,
  environment: string,
  globalConfigPath: string,
  reader: TomlFileReader,
  env: Record<string, string | undefined>
): EnvironmentConfig {
  // 1. Read project name from .semiont/config
  const projectConfigContent = reader.readIfExists(`${projectRoot}/.semiont/config`);
  let projectName = 'semiont-project';
  if (projectConfigContent) {
    const projectConfig = parseToml(projectConfigContent) as { project?: { name?: string } };
    projectName = projectConfig.project?.name ?? projectName;
  }

  // 2. Read global config (optional — missing config yields empty environments)
  const globalContent = reader.readIfExists(globalConfigPath);
  const raw = globalContent ? (parseToml(globalContent) as SemiontConfigFile) : ({} as SemiontConfigFile);

  // 3. Extract environment section
  const envSection: EnvironmentSection = raw.environments?.[environment] ?? {};

  // 4. Resolve ${VAR} references
  const resolved = resolveEnvVars(envSection, env) as EnvironmentSection;

  // 5. Build make-meaning actor/worker inference config with inheritance
  const makeMeaningSection = resolved['make-meaning'];
  const workersSection = resolved.workers ?? {};
  const defaultWorkerInference = workersSection['default']?.inference;
  const defaultMakeMeaningInference = makeMeaningSection?.default?.inference;

  const actors: ActorInferenceConfig = {};
  if (makeMeaningSection?.actors?.gatherer?.inference) {
    actors.gatherer = makeMeaningSection.actors.gatherer.inference;
  } else if (defaultMakeMeaningInference) {
    actors.gatherer = defaultMakeMeaningInference;
  }
  if (makeMeaningSection?.actors?.matcher?.inference) {
    actors.matcher = makeMeaningSection.actors.matcher.inference;
  } else if (defaultMakeMeaningInference) {
    actors.matcher = defaultMakeMeaningInference;
  }

  const workers: WorkerInferenceConfig = {};
  const workerTypes = ['reference-annotation', 'highlight-annotation', 'assessment-annotation', 'comment-annotation', 'tag-annotation', 'generation'] as const;
  if (defaultWorkerInference) {
    workers.default = defaultWorkerInference;
  }
  for (const wt of workerTypes) {
    const specific = workersSection[wt]?.inference;
    if (specific) {
      (workers as Record<string, InferenceConfig>)[wt] = specific;
    }
  }

  // 6. Map to EnvironmentConfig
  const backend = resolved.backend;
  const site = resolved.site;
  const inferenceSection = resolved.inference;

  // Build inference providers config
  let inferenceProviders: EnvironmentConfig['inference'] | undefined;
  if (inferenceSection) {
    inferenceProviders = {};
    if (inferenceSection.ollama) {
      const s = inferenceSection.ollama;
      inferenceProviders.ollama = {
        platform: { type: (s.platform ?? 'posix') as PlatformType },
        baseURL: s.baseURL,
        port: s.port,
        image: s.image,
        command: s.command,
        timeout: s.timeout,
        wait: s.wait,
        logsEndpoint: s.logsEndpoint,
      } as OllamaProviderConfig;
    }
    if (inferenceSection.anthropic) {
      const s = inferenceSection.anthropic;
      inferenceProviders.anthropic = {
        platform: 'external',
        endpoint: s.endpoint ?? 'https://api.anthropic.com',
        apiKey: s.apiKey ?? '',
      } as AnthropicProviderConfig;
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
  const actorsSection = resolved.actors ?? {};
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

  const config: EnvironmentConfig = {
    services: {
      backend: backend ? {
        platform: { type: 'posix' },
        port: backend.port ?? 3001,
        publicURL: backend.publicURL ?? `http://localhost:${backend.port ?? 3001}`,
        corsOrigin: backend.corsOrigin ?? backend.frontendURL ?? 'http://localhost:3000',
      } : undefined,
      graph: makeMeaningSection?.graph as EnvironmentConfig['services']['graph'],
    },
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
  return (projectRoot: string, environment: string): EnvironmentConfig => {
    return loadTomlConfig(projectRoot, environment, globalConfigPath, reader, env);
  };
}
