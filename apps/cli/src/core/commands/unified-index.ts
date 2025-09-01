/**
 * Unified Commands Index
 * 
 * Exports all commands that have been migrated to the UnifiedExecutor architecture.
 * This file can be used to gradually migrate from old implementations to new ones.
 */

// Export all unified command implementations
export { check, checkCommand } from './check-unified.js';
export { start, startCommand } from './start-unified.js';
export { update, updateCommand } from './update-unified.js';
export { publish, publishCommand } from './publish-unified.js';
export { provision, provisionCommand } from './provision-unified.js';

// Export the command result types for use in tests and other code
export type { CommandResult, CommandExtensions } from '../command-result.js';

/**
 * Map of all unified commands for easy access
 */
export const unifiedCommands = {
  check: () => import('./check-unified.js'),
  start: () => import('./start-unified.js'),
  update: () => import('./update-unified.js'),
  publish: () => import('./publish-unified.js'),
  provision: () => import('./provision-unified.js'),
} as const;

/**
 * Helper to check if a command has been migrated to unified architecture
 */
export function isUnifiedCommand(commandName: string): boolean {
  return commandName in unifiedCommands;
}

/**
 * Load a unified command dynamically
 */
export async function loadUnifiedCommand(commandName: string) {
  if (!isUnifiedCommand(commandName)) {
    throw new Error(`Command ${commandName} has not been migrated to unified architecture`);
  }
  
  const loader = unifiedCommands[commandName as keyof typeof unifiedCommands];
  return loader();
}