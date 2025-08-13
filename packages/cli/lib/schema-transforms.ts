/**
 * Schema transformation utilities
 * Converts between CLI argument schemas (--environment) and command schemas (environment)
 */

import { z } from 'zod';

/**
 * Standard command options schema with clean property names
 */
export const BaseCommandSchema = z.object({
  environment: z.string(),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  help: z.boolean().default(false),
});

export type BaseCommandOptions = z.infer<typeof BaseCommandSchema>;

/**
 * Transform CLI args (--environment) to clean command options (environment)
 */
export function transformCliArgs(rawArgs: Record<string, any>): Record<string, any> {
  const transformed: Record<string, any> = {};
  
  for (const [key, value] of Object.entries(rawArgs)) {
    if (key.startsWith('--')) {
      // Convert --environment to environment
      const cleanKey = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      transformed[cleanKey] = value;
    } else if (!key.startsWith('-')) {
      // Keep non-flag arguments as-is
      transformed[key] = value;
    }
  }
  
  return transformed;
}

/**
 * Command-specific schemas with clean property names
 */

export const CheckCommandSchema = BaseCommandSchema.extend({
  section: z.enum(['all', 'services', 'health', 'logs']).default('all'),
});

export const WatchCommandSchema = BaseCommandSchema.extend({
  target: z.enum(['all', 'logs', 'metrics', 'services']).default('all'),
  service: z.enum(['all', 'frontend', 'backend', 'database']).default('all'),
  follow: z.boolean().default(true),
  interval: z.number().int().positive().default(5),
});

export const StartCommandSchema = BaseCommandSchema.extend({
  service: z.enum(['all', 'frontend', 'backend', 'database']).default('all'),
});

export const ExecCommandSchema = BaseCommandSchema.extend({
  service: z.enum(['frontend', 'backend']).default('backend'),
  command: z.string().default('/bin/sh'),
});

export const ConfigureCommandSchema = BaseCommandSchema.extend({
  secretPath: z.string().optional(),
  value: z.string().optional(),
});

export const BackupCommandSchema = BaseCommandSchema.extend({
  name: z.string().optional(),
});

export const TestCommandSchema = BaseCommandSchema.extend({
  suite: z.enum(['all', 'integration', 'e2e', 'health', 'security']).default('all'),
  service: z.enum(['all', 'frontend', 'backend']).default('all'),
  coverage: z.boolean().default(false),
  parallel: z.boolean().default(false),
  timeout: z.number().int().positive().optional(),
});