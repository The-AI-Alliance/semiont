/**
 * Base Options Schema - Zod schema for common command options
 *
 * Three tiers:
 *   BaseOptionsSchema  — fields shared by every command (no environment, no bus)
 *   OpsOptionsSchema   — + --environment  (platform/service commands)
 *   ApiOptionsSchema   — + --bus          (API commands that talk to the backend)
 */

import { z } from 'zod';
import { type ArgDefinition } from './command-definition.js';

/**
 * Fields common to every command.
 */
export const BaseOptionsSchema = z.object({
  verbose: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
  quiet: z.boolean().optional().default(false),
  output: z.enum(['summary', 'table', 'json', 'yaml']).optional().default('summary'),
  forceDiscovery: z.boolean().optional().default(false),
  preflight: z.boolean().optional().default(false),
});

/**
 * Schema for platform/service commands that need --environment.
 */
export const OpsOptionsSchema = BaseOptionsSchema.extend({
  environment: z.string().optional(),
});

/**
 * Schema for API commands that talk to the backend via --bus.
 * No --environment, no --user, no --password — use `semiont login` to authenticate.
 */
export const ApiOptionsSchema = BaseOptionsSchema.extend({
  bus: z.string().optional(),
});

/**
 * Type helper to extract the inferred type from a Zod schema
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
 * Argument definitions shared by all commands (no --environment).
 */
export const BASE_ARGS: Record<string, ArgDefinition> = {
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
  '--preflight': {
    type: 'boolean',
    description: 'Run preflight checks only without executing the command',
    default: false,
  },
};

/**
 * Additional argument definitions for ops commands (adds --environment).
 */
export const OPS_ARGS: Record<string, ArgDefinition> = {
  '--environment': {
    type: 'string',
    description: 'Target environment',
    required: false,
  },
};

/**
 * Additional argument definitions for API commands (adds --bus).
 */
export const API_ARGS: Record<string, ArgDefinition> = {
  '--bus': {
    type: 'string',
    description:
      'Backend URL (e.g. http://localhost:4000). ' +
      'Fallback: $SEMIONT_BUS. Use `semiont login` to authenticate.',
  },
};

/**
 * Aliases shared by all commands.
 */
export const BASE_ALIASES: Record<string, string> = {
  '-v': '--verbose',
  '-q': '--quiet',
  '-o': '--output',
};

export const OPS_ALIASES: Record<string, string> = {
  '-e': '--environment',
};

export const API_ALIASES: Record<string, string> = {
  '-b': '--bus',
};

/**
 * Helper for ops commands (platform/service management).
 * Includes base args plus --environment.
 */
export function withOpsArgs(
  commandArgs: Record<string, ArgDefinition> = {},
  commandAliases: Record<string, string> = {},
  positional?: string[]
) {
  return {
    args: { ...BASE_ARGS, ...OPS_ARGS, ...commandArgs },
    aliases: { ...BASE_ALIASES, ...OPS_ALIASES, ...commandAliases },
    ...(positional && { positional }),
  };
}

/**
 * Helper for API commands that talk to the backend.
 * Includes base args plus --bus.
 */
export function withApiArgs(
  commandArgs: Record<string, ArgDefinition> = {},
  commandAliases: Record<string, string> = {},
  positional?: string[]
) {
  return {
    args: { ...BASE_ARGS, ...API_ARGS, ...commandArgs },
    aliases: { ...BASE_ALIASES, ...API_ALIASES, ...commandAliases },
    ...(positional && { positional }),
  };
}
