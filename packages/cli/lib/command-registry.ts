/**
 * Command Registry - Legacy file kept for backward compatibility
 * 
 * This file is largely deprecated. The new command system uses:
 * - command-definition.ts for CommandBuilder and CommandDefinition
 * - command-loader.ts for dynamic command loading
 * - Individual command files that export their definitions using CommandBuilder
 * 
 * This file now only exports types that may still be referenced.
 */

import { CommandFunction } from './command-types.js';
import { BaseCommandOptions } from './base-command-options.js';

/**
 * @deprecated Use CommandDefinition from command-definition.ts instead
 */
export interface LegacyCommandMetadata {
  name: string;
  description: string;
  requiresServices: boolean;
}

/**
 * @deprecated Commands are now loaded dynamically from their modules
 */
export function isRegisteredCommand(_commandName: string): boolean {
  console.warn('isRegisteredCommand is deprecated. Use getAvailableCommands from command-loader.js');
  return false;
}

/**
 * @deprecated Use loadCommand from command-loader.js instead
 */
export function getCommandMetadata(_commandName: string): LegacyCommandMetadata | null {
  console.warn('getCommandMetadata is deprecated. Use loadCommand from command-loader.js');
  return null;
}

/**
 * Validate that a command module exports the expected function
 * This is still used by some legacy code paths
 */
export function validateCommandModule<T extends BaseCommandOptions>(
  module: Record<string, unknown>,
  commandName: string
): CommandFunction<T> | null {
  const command = module[commandName];
  
  if (typeof command === 'function' && command.length === 2) {
    return command as CommandFunction<T>;
  }
  
  return null;
}