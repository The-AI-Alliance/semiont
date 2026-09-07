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
import type { EnvironmentConfig } from './config.types';
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
/** The archivist's default port — the ONE home; node-config-loader imports it. */
export declare const DEFAULT_ARCHIVIST_PORT = 24103;
export type TomlFileReader = {
    readIfExists: (path: string) => string | null;
};
/**
 * Parse ~/.semiontconfig and .semiont/config and return EnvironmentConfig.
 *
 * @param projectRoot - Path to the project root (contains .semiont/config)
 * @param environment - Environment name (e.g. 'local', 'production'); when
 *   undefined, resolved from `[defaults] environment`
 * @param globalConfigPath - Path to ~/.semiontconfig (caller resolves ~ expansion)
 * @param reader - File reader abstraction
 * @param env - Environment variables for ${VAR} resolution
 */
export declare function loadTomlConfig(projectRoot: string | null, environment: string | undefined, globalConfigPath: string, reader: TomlFileReader, env: Record<string, string | undefined>): EnvironmentConfig;
/**
 * Create a TOML config loader backed by a file reader.
 * Drop-in replacement for createConfigLoader that reads TOML instead of JSON.
 * The caller must resolve globalConfigPath (e.g. expand '~' using process.env.HOME).
 */
export declare function createTomlConfigLoader(reader: TomlFileReader, globalConfigPath: string, env: Record<string, string | undefined>): (projectRoot: string | null, environment?: string) => EnvironmentConfig;
