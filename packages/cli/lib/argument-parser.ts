/**
 * Shared argument parsing utilities for CLI commands
 * Standardizes the arg + zod pattern across all commands
 */

import { z } from 'zod';

/**
 * Standard options available to all commands
 */
export const BaseOptionsSchema = z.object({
  environment: z.string(),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  help: z.boolean().default(false),
});

export type BaseOptions = z.infer<typeof BaseOptionsSchema>;

/**
 * Parse command arguments using environment variables and CLI flags
 * This standardizes how commands receive arguments from the main CLI
 */
export function parseCommandArgs<T extends BaseOptions>(
  schema: z.ZodType<T>,
  commandName: string
): T {
  // Arguments come from environment variables set by main CLI
  const rawOptions: any = {
    environment: process.env.SEMIONT_ENV,
    verbose: process.env.SEMIONT_VERBOSE === '1',
    dryRun: process.env.SEMIONT_DRY_RUN === '1',
    help: false, // Help is handled by main CLI
  };

  // Additional arguments come from process.argv
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    
    // Parse common arguments that might be passed directly
    switch (arg) {
      case '--verbose':
      case '-v':
        rawOptions.verbose = true;
        break;
      case '--dry-run':
        rawOptions.dryRun = true;
        break;
      case '--help':
      case '-h':
        rawOptions.help = true;
        break;
      default:
        // Command-specific arguments can be handled by extending this
        break;
    }
  }

  try {
    return schema.parse(rawOptions);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error(`❌ Invalid arguments for ${commandName}:`);
      for (const issue of error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Parse key-value arguments like --name value or --service backend
 */
export function parseKeyValueArgs(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      
      if (nextArg && !nextArg.startsWith('--')) {
        // Key-value pair
        result[key] = nextArg;
        i++; // Skip the value
      } else {
        // Boolean flag
        result[key] = true;
      }
    } else if (arg.startsWith('-')) {
      // Short flag (boolean only)
      const key = arg.slice(1);
      result[key] = true;
    }
  }
  
  return result;
}