/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "PlatformType".
 */
export type PlatformType = 'posix' | 'container' | 'aws' | 'external';
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "GraphDatabaseType".
 */
export type GraphDatabaseType = 'neo4j' | 'janusgraph' | 'neptune' | 'memory';
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "GraphServiceConfig".
 */
export type GraphServiceConfig = {
    [k: string]: unknown;
} & {
    platform: ServicePlatformConfig;
    type: GraphDatabaseType;
    name?: string;
    uri?: string;
    url?: string;
    username?: string;
    password?: string;
    database?: string;
    host?: string;
    port?: number;
    storage?: string;
    index?: string;
    endpoint?: string;
    region?: string;
    command?: string;
    image?: string;
    janusgraphVersion?: string;
    javaOptions?: string;
    heapSize?: string;
    pageCacheSize?: string;
    noAuth?: boolean;
    dataPath?: string;
    timeout?: number;
    wait?: number;
    logsEndpoint?: string;
    tag?: string;
    resources?: ResourceRequirements;
    security?: SecurityRequirements;
    build?: boolean | BuildRequirements;
    dockerfile?: string;
    buildContext?: string;
    buildArgs?: {
        [k: string]: string;
    };
    buildTarget?: string;
    prebuilt?: boolean;
    noCache?: boolean;
    secrets?: string[];
    labels?: {
        [k: string]: string;
    };
    annotations?: {
        [k: string]: string;
    };
    dependencies?: string[];
    externalDependencies?: (string | {
        name?: string;
        url?: string;
        required?: boolean;
        healthCheck?: string;
        [k: string]: unknown;
    })[];
    environment?: {
        [k: string]: string;
    };
    env?: {
        [k: string]: string;
    };
};
export interface HttpsSemiontOrgSchemasConfigJson {
    [k: string]: unknown;
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "ServicePlatformConfig".
 */
export interface ServicePlatformConfig {
    type: PlatformType;
    [k: string]: unknown;
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "ResourceRequirements".
 */
export interface ResourceRequirements {
    cpu?: string;
    memory?: string;
    gpu?: number;
    gpus?: number;
    replicas?: number;
    ephemeralStorage?: string;
    memoryReservation?: string;
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "SecurityRequirements".
 */
export interface SecurityRequirements {
    readOnlyRootFilesystem?: boolean;
    runAsNonRoot?: boolean;
    runAsUser?: number;
    runAsGroup?: number;
    capabilities?: string[] | {
        add?: string[];
        drop?: string[];
        [k: string]: unknown;
    };
    privileged?: boolean;
    allowPrivilegeEscalation?: boolean;
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "BuildRequirements".
 */
export interface BuildRequirements {
    dockerfile?: string;
    buildContext?: string;
    buildArgs?: {
        [k: string]: string;
    };
    buildTarget?: string;
    prebuilt?: boolean;
    noCache?: boolean;
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "GatewayServiceConfig".
 */
export interface GatewayServiceConfig {
    platform: ServicePlatformConfig;
    devMode?: boolean;
    command?: string;
    port: number;
    publicURL: string;
    image?: string;
    cpu?: string;
    memory?: string;
    databaseUrl?: string;
    projectRoot?: string;
    timeout?: number;
    wait?: number;
    logsEndpoint?: string;
    tag?: string;
    resources?: ResourceRequirements;
    security?: SecurityRequirements;
    build?: boolean | BuildRequirements;
    dockerfile?: string;
    buildContext?: string;
    buildArgs?: {
        [k: string]: string;
    };
    buildTarget?: string;
    prebuilt?: boolean;
    noCache?: boolean;
    secrets?: string[];
    labels?: {
        [k: string]: string;
    };
    annotations?: {
        [k: string]: string;
    };
    dependencies?: string[];
    externalDependencies?: (string | {
        name?: string;
        url?: string;
        required?: boolean;
        healthCheck?: string;
        [k: string]: unknown;
    })[];
    redisUrl?: string;
    environment?: {
        [k: string]: string;
    };
    env?: {
        [k: string]: string;
    };
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "VectorsServiceConfig".
 */
export interface VectorsServiceConfig {
    platform?: ServicePlatformConfig;
    type: 'qdrant' | 'memory';
    host?: string;
    port?: number;
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "EmbeddingServiceConfig".
 */
export interface EmbeddingServiceConfig {
    platform?: ServicePlatformConfig;
    type: 'voyage' | 'ollama';
    model: string;
    apiKey?: string;
    baseURL?: string;
    endpoint?: string;
    chunking?: {
        chunkSize?: number;
        overlap?: number;
        [k: string]: unknown;
    };
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "DatabaseServiceConfig".
 */
export interface DatabaseServiceConfig {
    platform: ServicePlatformConfig;
    type: string;
    name?: string;
    host: string;
    port: number;
    environment?: {
        [k: string]: string;
    };
    env?: {
        [k: string]: string;
    };
    description?: string;
    command?: string;
    image?: string;
    user?: string;
    username?: string;
    password?: string;
    database?: string;
    /**
     * Override the default data storage directory ($XDG_DATA_HOME/semiont/{name}/database/{service})
     */
    dataDir?: string;
    storageSize?: string;
    timeout?: number;
    wait?: number;
    logsEndpoint?: string;
    tag?: string;
    resources?: ResourceRequirements;
    security?: SecurityRequirements;
    build?: boolean | BuildRequirements;
    dockerfile?: string;
    buildContext?: string;
    buildArgs?: {
        [k: string]: string;
    };
    buildTarget?: string;
    prebuilt?: boolean;
    noCache?: boolean;
    secrets?: string[];
    labels?: {
        [k: string]: string;
    };
    annotations?: {
        [k: string]: string;
    };
    dependencies?: string[];
    externalDependencies?: (string | {
        name?: string;
        url?: string;
        required?: boolean;
        healthCheck?: string;
        [k: string]: unknown;
    })[];
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "OllamaProviderConfig".
 */
export interface OllamaProviderConfig {
    platform: ServicePlatformConfig;
    baseURL?: string;
    port?: number;
    image?: string;
    command?: string;
    timeout?: number;
    wait?: number;
    logsEndpoint?: string;
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "AnthropicProviderConfig".
 */
export interface AnthropicProviderConfig {
    platform: 'external';
    endpoint: string;
    apiKey: string;
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "InferenceProvidersConfig".
 */
export interface InferenceProvidersConfig {
    ollama?: OllamaProviderConfig;
    anthropic?: AnthropicProviderConfig;
    [k: string]: unknown;
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "McpServiceConfig".
 */
export interface McpServiceConfig {
    platform: ServicePlatformConfig;
    command?: string;
    image?: string;
    port?: number;
    dependsOn?: string[];
    timeout?: number;
    wait?: number;
    logsEndpoint?: string;
    tag?: string;
    resources?: ResourceRequirements;
    security?: SecurityRequirements;
    build?: boolean | BuildRequirements;
    dockerfile?: string;
    buildContext?: string;
    buildArgs?: {
        [k: string]: string;
    };
    buildTarget?: string;
    prebuilt?: boolean;
    noCache?: boolean;
    secrets?: string[];
    labels?: {
        [k: string]: string;
    };
    annotations?: {
        [k: string]: string;
    };
    dependencies?: string[];
    externalDependencies?: (string | {
        name?: string;
        url?: string;
        required?: boolean;
        healthCheck?: string;
        [k: string]: unknown;
    })[];
    environment?: {
        [k: string]: string;
    };
    env?: {
        [k: string]: string;
    };
}
/**
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "ServicesConfig".
 */
export interface ServicesConfig {
    gateway?: GatewayServiceConfig;
    database?: DatabaseServiceConfig;
    graph?: GraphServiceConfig;
    mcp?: McpServiceConfig;
    vectors: VectorsServiceConfig;
    embedding: EmbeddingServiceConfig;
    archivist?: ArchivistServiceConfig;
    [k: string]: unknown;
}
/**
 * The Archivist service — the out-of-process keeper of the record (EXTRACT-ARCHIVIST). Internal-only: the gateway dials host:port for the D1 sequence-ranged event read path; nothing public.
 *
 * This interface was referenced by `HttpsSemiontOrgSchemasConfigJson`'s JSON-Schema
 * via the `definition` "ArchivistServiceConfig".
 */
export interface ArchivistServiceConfig {
    platform?: ServicePlatformConfig;
    host?: string;
    port?: number;
    image?: string;
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
    siteName?: string;
    /**
     * Primary domain for the site
     */
    domain?: string;
    /**
     * Administrator email address
     */
    adminEmail?: string;
    /**
     * Support email address (optional)
     */
    supportEmail?: string;
    /**
     * Email domains allowed for OAuth authentication
     *
     * @minItems 1
     */
    oauthAllowedDomains?: [string, ...string[]];
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
        projectRoot: string | null;
        [k: string]: unknown;
    };
    /**
     * Environment name
     */
    name?: string;
    /**
     * The KB's committed identity, staged by the launcher (SINGLE-KB-MOUNT D4). Top-level in the staged file, out of any environment section's reach; never overridable.
     */
    kb?: {
        name: string;
        domain?: string;
        /**
         * Sign-in policy committed in the KB's .semiont/config, staged alongside the identity because the gateway no longer mounts the tree that holds it.
         */
        oauthAllowedDomains?: string[];
    };
    platform?: {
        default?: PlatformType;
        [k: string]: unknown;
    };
    services: ServicesConfig;
    inference?: InferenceProvidersConfig;
    workers?: {
        [k: string]: {
            inference?: {
                type?: string;
                model?: string;
                [k: string]: unknown;
            };
            [k: string]: unknown;
        };
    };
    actors?: {
        [k: string]: {
            inference?: {
                type?: string;
                model?: string;
                [k: string]: unknown;
            };
            [k: string]: unknown;
        };
    };
    site?: SiteConfig;
    app?: AppConfig;
    env?: {
        NODE_ENV?: 'development' | 'production' | 'test';
        [k: string]: unknown;
    };
    /**
     * Logging verbosity level
     */
    logLevel?: 'error' | 'warn' | 'info' | 'http' | 'debug';
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
    services?: ServicesConfig;
}
