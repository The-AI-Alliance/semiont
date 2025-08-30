/**
 * Base Options Schema - Zod schema for common command options
 * 
 * This provides the base Zod schema that all commands can extend,
 * ensuring type safety throughout the command pipeline.
 */

import { z } from 'zod';
import { type ArgDefinition } from '../commands/command-definition.js';

/**
 * Base Zod schema for options common to all commands
 * 
 * Note: Fields are optional to allow CLI args to be omitted,
 * but have defaults so they're always defined at runtime
 */
export const BaseOptionsSchema = z.object({
  environment: z.string().optional(),
  verbose: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
  quiet: z.boolean().optional().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).optional().default('summary'),
  forceDiscovery: z.boolean().optional().default(false),
});

/**
 * Type helper to extract the inferred type from a Zod schema
 * This is re-exported for convenience
 */
export type InferSchema<T extends z.ZodType<any, any>> = z.infer<T>;

/**
 * Common schema extensions that commands frequently use
 */
export const CommonExtensions = {
  service: z.string().optional(),
  all: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  yes: z.boolean().optional().default(false),
  tag: z.string().optional(),
  registry: z.string().optional(),
} as const;

/**
 * Common argument definitions that match BaseOptionsSchema
 * These can be spread into any command's args definition
 */
export const BASE_ARGS: Record<string, ArgDefinition> = {
  '--environment': { 
    type: 'string', 
    description: 'Target environment',
    required: false,
  },
  '--verbose': { 
    type: 'boolean', 
    description: 'Verbose output',
    default: false,
  },
  '--dry-run': { 
    type: 'boolean', 
    description: 'Simulate actions without executing',
    default: false,
  },
  '--quiet': { 
    type: 'boolean', 
    description: 'Suppress output',
    default: false,
  },
  '--output': { 
    type: 'string', 
    description: 'Output format',
    choices: ['summary', 'table', 'json', 'yaml'],
    default: 'summary',
  },
  '--force-discovery': { 
    type: 'boolean', 
    description: 'Force rediscovery of cloud resources (rebuilds cache)',
    default: false,
  },
};

/**
 * Common aliases for base arguments
 */
export const BASE_ALIASES: Record<string, string> = {
  '-e': '--environment',
  '-v': '--verbose',
  '-q': '--quiet',
  '-o': '--output',
};

/**
 * Helper to merge base args with command-specific args
 */
export function withBaseArgs(
  commandArgs: Record<string, ArgDefinition> = {},
  commandAliases: Record<string, string> = {},
  positional?: string[]
) {
  return {
    args: { ...BASE_ARGS, ...commandArgs },
    aliases: { ...BASE_ALIASES, ...commandAliases },
    ...(positional && { positional }),
  };
}