/**
 * Argument Parser - Functional parser generator for CLI arguments
 * 
 * This module provides a functional approach to generating argument parsers
 * from declarative command definitions.
 */

import arg from 'arg';
import { z } from 'zod';
import type { CommandDefinition, ArgSpec } from '../command-definition.js';

/**
 * Type mapping from our declarative types to arg library types
 */
const ARG_TYPE_MAP = {
  string: String,
  boolean: Boolean,
  number: Number,
  array: [String] as [StringConstructor],
};

/**
 * Create a parser function for a command
 */
export function createArgParser<T>(
  command: CommandDefinition<T>
): (argv: string[]) => T {
  const argSpec = buildArgSpec(command.argSpec);
  
  return (argv: string[]) => {
    try {
      // Parse with arg library
      const rawArgs = arg(argSpec, { argv, permissive: false });
      
      // Normalize to match Zod schema expectations
      const normalized = normalizeArgs(rawArgs, command.argSpec);
      
      // Validate with Zod
      const validated = command.schema.parse(normalized);
      
      return validated;
    } catch (error) {
      if (error instanceof arg.ArgError) {
        throw new Error(`Invalid arguments: ${error.message}`);
      }
      if (error instanceof z.ZodError) {
        const issues = error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`Invalid arguments:\n${issues}`);
      }
      throw error;
    }
  };
}

/**
 * Build arg library specification from our declarative format
 */
function buildArgSpec(spec: ArgSpec): arg.Spec {
  const result: arg.Spec = {};
  
  // Add argument type definitions
  for (const [key, def] of Object.entries(spec.args)) {
    result[key] = ARG_TYPE_MAP[def.type];
  }
  
  // Add aliases
  if (spec.aliases) {
    Object.assign(result, spec.aliases);
  }
  
  return result;
}

/**
 * Normalize parsed arguments to match Zod schema expectations
 * 
 * The arg library returns arguments with '--' prefix, but our schemas
 * expect camelCase property names.
 */
function normalizeArgs(
  rawArgs: Record<string, any>,
  spec: ArgSpec
): Record<string, any> {
  const normalized: Record<string, any> = {};
  
  // Handle positional arguments
  if (spec.positional && rawArgs._) {
    spec.positional.forEach((name, index) => {
      if (rawArgs._[index] !== undefined) {
        normalized[name] = rawArgs._[index];
      }
    });
  }
  
  // Handle named arguments
  for (const [key, value] of Object.entries(rawArgs)) {
    if (key === '_') continue; // Skip positional args array
    
    // Convert --kebab-case to camelCase
    const normalizedKey = kebabToCamel(key.replace(/^--/, ''));
    
    // Handle special cases for 'no-' prefix arguments
    if (key === '--no-compress' && spec.args['--no-compress']) {
      // Invert boolean for 'no-' prefix arguments
      normalized.compress = !value;
    } else if (value !== undefined) {
      normalized[normalizedKey] = value;
    }
  }
  
  // Apply defaults from spec
  for (const [key, def] of Object.entries(spec.args)) {
    const normalizedKey = kebabToCamel(key.replace(/^--/, ''));
    if (normalized[normalizedKey] === undefined && def.default !== undefined) {
      normalized[normalizedKey] = def.default;
    }
  }
  
  return normalized;
}

/**
 * Convert kebab-case to camelCase
 */
function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Generate help text from command definition
 */
export function generateHelp(command: CommandDefinition<any>): string {
  const lines: string[] = [];
  
  lines.push(`${command.name} - ${command.description}`);
  lines.push('');
  lines.push('OPTIONS:');
  
  // Calculate max key length for alignment
  const maxKeyLength = Math.max(
    ...Object.keys(command.argSpec.args).map(k => k.length),
    ...(command.argSpec.aliases ? Object.keys(command.argSpec.aliases).map(k => k.length) : [])
  );
  
  // Add argument descriptions
  for (const [key, def] of Object.entries(command.argSpec.args)) {
    const aliases = findAliases(key, command.argSpec.aliases);
    const keyStr = aliases.length > 0 
      ? `${aliases.join(', ')}, ${key}`.padEnd(maxKeyLength + 10)
      : key.padEnd(maxKeyLength + 10);
    
    let description = def.description;
    if (def.choices) {
      description += ` (${def.choices.join(', ')})`;
    }
    if (def.default !== undefined) {
      description += ` [default: ${def.default}]`;
    }
    if (def.required) {
      description += ' (required)';
    }
    
    lines.push(`  ${keyStr} ${description}`);
  }
  
  if (command.examples.length > 0) {
    lines.push('');
    lines.push('EXAMPLES:');
    for (const example of command.examples) {
      lines.push(`  ${example}`);
    }
  }
  
  return lines.join('\n');
}

/**
 * Find aliases for a given argument key
 */
function findAliases(
  key: string,
  aliases?: Record<string, string>
): string[] {
  if (!aliases) return [];
  
  return Object.entries(aliases)
    .filter(([_, target]) => target === key)
    .map(([alias]) => alias);
}

/**
 * Validate that required arguments are present
 */
export function validateRequiredArgs<T>(
  parsed: T,
  command: CommandDefinition<T>
): void {
  const missing: string[] = [];
  
  for (const [key, def] of Object.entries(command.argSpec.args)) {
    if (def.required) {
      const normalizedKey = kebabToCamel(key.replace(/^--/, ''));
      if (parsed[normalizedKey as keyof T] === undefined) {
        missing.push(key);
      }
    }
  }
  
  if (missing.length > 0) {
    throw new Error(`Missing required arguments: ${missing.join(', ')}`);
  }
}