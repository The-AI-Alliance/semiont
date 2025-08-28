/**
 * Command Definition - Unified structure for CLI command metadata
 * 
 * This module defines the complete structure for command definitions,
 * combining argument specifications, validation schemas, and handlers.
 */

import { z } from 'zod';
import type { CommandFunction, ServiceCommandFunction, SetupCommandFunction } from '../commands/command-types.js';
import { BASE_ARGS, BASE_ALIASES } from '../commands/base-options-schema.js';

/**
 * Declarative argument definition for CLI parsing
 */
export interface ArgDefinition {
  type: 'string' | 'boolean' | 'number' | 'array';
  description: string;
  default?: any;
  choices?: readonly string[];
  required?: boolean;
}

/**
 * Declarative argument specification
 */
export interface ArgSpec {
  args: Record<string, ArgDefinition>;
  aliases?: Record<string, string>;
  positional?: string[]; // For commands like 'configure get <key>'
}

/**
 * Complete command definition with all metadata
 * 
 * @template TInput - The input type (what the CLI parser provides)
 * @template TOptions - The output type (what the handler receives after schema processing)
 * @template TResult - The type of service-specific results (defaults to any)
 */
export interface CommandDefinition<TInput = any, TOptions = TInput, TResult = any> {
  name: string;
  description: string;
  schema: z.ZodType<TOptions, any, TInput>;
  argSpec: ArgSpec;
  requiresEnvironment: boolean;
  requiresServices: boolean;
  examples: string[];
  handler: CommandFunction<TOptions, TResult>;
  
  /**
   * Discriminator to help runtime determine handler type
   */
  handlerType?: 'service' | 'setup';
}

/**
 * Type-safe command builder for creating command definitions
 * 
 * @template TInput - The input type (what the CLI parser provides)
 * @template TOptions - The options type (what the handler receives after schema processing)
 * @template TResult - The type of command results (defaults to any)
 */
export class CommandBuilder<TInput = any, TOptions = TInput, TResult = any> {
  private definition: Partial<CommandDefinition<TInput, TOptions, TResult>> = {
    requiresEnvironment: true, // Most commands need this
    requiresServices: true,     // Most commands need this
    examples: [],
    // Provide default args based on common patterns
    argSpec: {
      args: BASE_ARGS,
      aliases: BASE_ALIASES,
    },
  };

  name(name: string): this {
    this.definition.name = name;
    return this;
  }

  description(desc: string): this {
    this.definition.description = desc;
    return this;
  }

  schema<S extends z.ZodSchema>(schema: S): CommandBuilder<z.input<S>, z.output<S>, TResult> {
    (this.definition as any).schema = schema;
    return this as any;
  }

  args(spec: ArgSpec): this {
    // Merge with defaults rather than replace
    this.definition.argSpec = {
      args: { ...BASE_ARGS, ...spec.args },
      aliases: { ...BASE_ALIASES, ...spec.aliases },
      positional: spec.positional,
    };
    return this;
  }

  requiresEnvironment(requires: boolean): this {
    this.definition.requiresEnvironment = requires;
    return this;
  }

  requiresServices(requires: boolean): this {
    this.definition.requiresServices = requires;
    return this;
  }

  examples(...examples: string[]): this {
    this.definition.examples = examples;
    return this;
  }

  handler<R>(fn: CommandFunction<TOptions, R>): CommandBuilder<TInput, TOptions, R> {
    (this.definition as any).handler = fn;
    // Auto-detect handler type based on requiresServices flag
    (this.definition as any).handlerType = this.definition.requiresServices ? 'service' : 'setup';
    return this as any;
  }
  
  /**
   * Type-safe handler for service commands
   */
  serviceHandler<R>(fn: ServiceCommandFunction<TOptions, R>): CommandBuilder<TInput, TOptions, R> {
    (this.definition as any).handler = fn;
    (this.definition as any).handlerType = 'service';
    this.definition.requiresServices = true;
    return this as any;
  }
  
  /**
   * Type-safe handler for setup commands
   */
  setupHandler<R>(fn: SetupCommandFunction<TOptions, R>): CommandBuilder<TInput, TOptions, R> {
    (this.definition as any).handler = fn;
    (this.definition as any).handlerType = 'setup';
    this.definition.requiresServices = false;
    return this as any;
  }

  build(): CommandDefinition<TInput, TOptions, TResult> {
    const { name, description, schema, argSpec, handler } = this.definition;
    
    if (!name) throw new Error('Command name is required');
    if (!description) throw new Error('Command description is required');
    if (!schema) throw new Error('Command schema is required');
    if (!argSpec) throw new Error('Command argSpec is required');
    if (!handler) throw new Error('Command handler is required');
    
    return this.definition as CommandDefinition<TInput, TOptions, TResult>;
  }
}

/**
 * Helper function to define a command with type safety
 */
export function defineCommand<TInput, TOptions = TInput, TResult = any>(
  definition: CommandDefinition<TInput, TOptions, TResult>
): CommandDefinition<TInput, TOptions, TResult> {
  return definition;
}

/**
 * Common argument definitions that can be reused across commands
 */
export const commonArgs = {
  environment: {
    type: 'string' as const,
    description: 'Target environment',
    required: true,
  },
  verbose: {
    type: 'boolean' as const,
    description: 'Enable verbose output',
    default: false,
  },
  dryRun: {
    type: 'boolean' as const,
    description: 'Preview changes without applying',
    default: false,
  },
  output: {
    type: 'string' as const,
    description: 'Output format',
    choices: ['summary', 'table', 'json', 'yaml'] as const,
    default: 'summary',
  },
  quiet: {
    type: 'boolean' as const,
    description: 'Suppress output except errors',
    default: false,
  },
  force: {
    type: 'boolean' as const,
    description: 'Force operation without confirmation',
    default: false,
  },
  service: {
    type: 'string' as const,
    description: 'Service name or "all"',
    default: 'all',
  },
} as const;

/**
 * Common aliases that can be reused across commands
 */
export const commonAliases = {
  '-e': '--environment',
  '-v': '--verbose',
  '-o': '--output',
  '-q': '--quiet',
  '-f': '--force',
  '-s': '--service',
  '-h': '--help',
} as const;