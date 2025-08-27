/**
 * Base Options Schema - Zod schema for common command options
 * 
 * This provides the base Zod schema that all commands can extend,
 * ensuring type safety throughout the command pipeline.
 */

import { z } from 'zod';

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