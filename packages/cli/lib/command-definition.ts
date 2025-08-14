/**
 * Command Definition - Unified structure for CLI command metadata
 * 
 * This module defines the complete structure for command definitions,
 * combining argument specifications, validation schemas, and handlers.
 */

import { z } from 'zod';
import type { CommandFunction, BaseCommandOptions } from './command-types.js';

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
 */
export interface CommandDefinition<TOptions extends BaseCommandOptions = BaseCommandOptions> {
  name: string;
  description: string;
  schema: z.ZodType<TOptions>;
  argSpec: ArgSpec;
  requiresEnvironment: boolean;
  requiresServices: boolean;
  examples: string[];
  handler: CommandFunction<TOptions>;
}

/**
 * Type-safe command builder for creating command definitions
 */
export class CommandBuilder<TOptions extends BaseCommandOptions> {
  private definition: Partial<CommandDefinition<TOptions>> = {
    requiresEnvironment: true, // Most commands need this
    requiresServices: true,     // Most commands need this
    examples: [],
  };

  name(name: string): this {
    this.definition.name = name;
    return this;
  }

  description(desc: string): this {
    this.definition.description = desc;
    return this;
  }

  schema(schema: z.ZodType<TOptions>): this {
    this.definition.schema = schema;
    return this;
  }

  args(spec: ArgSpec): this {
    this.definition.argSpec = spec;
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

  handler(fn: CommandFunction<TOptions>): this {
    this.definition.handler = fn;
    return this;
  }

  build(): CommandDefinition<TOptions> {
    const { name, description, schema, argSpec, handler } = this.definition;
    
    if (!name) throw new Error('Command name is required');
    if (!description) throw new Error('Command description is required');
    if (!schema) throw new Error('Command schema is required');
    if (!argSpec) throw new Error('Command argSpec is required');
    if (!handler) throw new Error('Command handler is required');
    
    return this.definition as CommandDefinition<TOptions>;
  }
}

/**
 * Helper function to define a command with type safety
 */
export function defineCommand<TOptions extends BaseCommandOptions>(
  definition: CommandDefinition<TOptions>
): CommandDefinition<TOptions> {
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