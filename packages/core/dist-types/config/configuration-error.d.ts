/**
 * Configuration Error Class
 *
 * Custom error class for configuration validation and loading errors.
 * Provides structured error information with helpful suggestions.
 */
export declare class ConfigurationError extends Error {
    environment?: string | undefined;
    suggestion?: string | undefined;
    readonly cause?: Error;
    constructor(message: string, environment?: string | undefined, suggestion?: string | undefined, cause?: Error);
    /**
     * Format the error nicely for CLI output
     */
    toString(): string;
}
