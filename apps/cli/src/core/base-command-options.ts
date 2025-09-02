/**
 * Base Command Options - Common options for all CLI commands
 * 
 * This is the single source of truth for the base options that all
 * commands must support.
 */

/**
 * Base options that all commands must support
 */
export interface BaseCommandOptions {
  environment?: string;  // Optional - can be provided via --environment or SEMIONT_ENV
  verbose?: boolean;
  dryRun?: boolean;
  output: 'summary' | 'table' | 'json' | 'yaml';
}