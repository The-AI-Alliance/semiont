/* Generated from config.schema.json - DO NOT EDIT MANUALLY */

/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "PlatformType".
 */
export type PlatformType = 'posix' | 'container' | 'aws' | 'external';

export interface HttpsSemiontOrgSchemasConfigJson {
  [k: string]: unknown;
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "SiteConfig".
 */
export interface SiteConfig {
  /**
   * Display name for the site
   */
  siteName: string;
  /**
   * Primary domain for the site
   */
  domain: string;
  /**
   * Administrator email address
   */
  adminEmail: string;
  /**
   * Support email address (optional)
   */
  supportEmail?: string;
  /**
   * Email domains allowed for OAuth authentication
   *
   * @minItems 1
   */
  oauthAllowedDomains: [string, ...string[]];
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "AppConfig".
 */
export interface AppConfig {
  features?: {
    enableAnalytics?: boolean;
    enableMaintenanceMode?: boolean;
    enableDebugLogging?: boolean;
  };
  security?: {
    /**
     * Session timeout in seconds
     */
    sessionTimeout?: number;
    /**
     * Maximum failed login attempts before lockout
     */
    maxLoginAttempts?: number;
    corsAllowedOrigins?: string[];
    /**
     * Enable local username/password authentication
     */
    enableLocalAuth?: boolean;
    /**
     * JWT signing secret (base64 encoded, 32+ bytes)
     */
    jwtSecret?: string;
  };
  performance?: {
    enableCaching?: boolean;
    /**
     * Cache timeout in seconds
     */
    cacheTimeout?: number;
    /**
     * Maximum request size (e.g., '10mb')
     */
    maxRequestSize?: string;
  };
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "EnvironmentConfig".
 */
export interface EnvironmentConfig {
  /**
   * Optional comment for documentation
   */
  _comment?: string;
  _metadata?: {
    environment: string;
    projectRoot: string;
    [k: string]: unknown;
  };
  platform?: {
    default?: PlatformType;
    [k: string]: unknown;
  };
  /**
   * Service-specific configurations
   */
  services: {
    [k: string]: unknown;
  };
  site: SiteConfig;
  app?: AppConfig;
  env?: {
    NODE_ENV?: 'development' | 'production' | 'test';
    [k: string]: unknown;
  };
  deployment?: {
    imageTagStrategy?: 'mutable' | 'immutable' | 'git-hash';
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "SemiontConfig".
 */
export interface SemiontConfig {
  /**
   * Config file version (semver)
   */
  version: string;
  /**
   * Project name
   */
  project: string;
  site: SiteConfig;
  app?: AppConfig;
  /**
   * Service definitions
   */
  services?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
