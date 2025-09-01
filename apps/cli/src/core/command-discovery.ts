/**
 * Command Discovery Module → What commands exist?
 * 
 * This module is responsible for discovering and loading command definitions.
 * It answers the fundamental question: "What commands are available?"
 * 
 * Responsibilities:
 * - Maintains the authoritative list of available commands
 * - Dynamically loads command definitions from their modules
 * - Caches loaded commands for performance
 * - Provides metadata about commands (requiresServices, requiresEnvironment)
 * 
 * This is the SINGLE SOURCE OF TRUTH for what commands exist in the CLI.
 * No other module should maintain lists of commands.
 */

import type { CommandDefinition } from './command-definition.js';

/**
 * Cache of loaded command definitions
 */
const commandCache = new Map<string, CommandDefinition<any>>();

/**
 * Map of command names to their module paths
 * This provides the mapping but will eventually be replaced by filesystem scanning
 */
const COMMAND_MODULES: Record<string, string> = {
  'init': './commands/init.js',
  'start': './commands/start.js',
  'stop': './commands/stop.js',
  'check': './commands/check.js',
  'provision': './commands/provision.js',
  'provision-cdk': './commands/provision-cdk.js',
  'publish': './commands/publish.js',
  'test': './commands/test.js',
  'update': './commands/update.js',
  'watch': './commands/watch.js',
};

/**
 * Load a command definition by name
 * 
 * @param name - The command name
 * @returns The command definition
 * @throws Error if command not found or invalid
 */
export async function loadCommand(name: string): Promise<CommandDefinition<any>> {
  // Check cache first
  if (commandCache.has(name)) {
    return commandCache.get(name)!;
  }
  
  const modulePath = COMMAND_MODULES[name];
  if (!modulePath) {
    throw new Error(`Command '${name}' not found`);
  }
  
  try {
    const module = await import(modulePath);
    
    // Look for the command export (could be named export or default)
    // Handle hyphenated command names by converting to camelCase for the export name
    const camelName = name.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
    const command = module[`${camelName}Command`] || module.default || module[name];
    
    if (!command) {
      throw new Error(`Command module does not export '${camelName}Command', 'default', or '${name}'`);
    }
    
    // Validate it's a proper command definition
    if (!isCommandDefinition(command)) {
      throw new Error(`Exported command does not match CommandDefinition interface`);
    }
    
    // Cache for future use
    commandCache.set(name, command);
    
    return command;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Cannot find module')) {
      throw new Error(`Command '${name}' module not found at ${modulePath}`);
    }
    throw error;
  }
}

/**
 * Get all available command names
 * 
 * @returns Array of command names
 */
export async function getAvailableCommands(): Promise<string[]> {
  // For now, return the keys from our module map
  // Eventually this should scan the filesystem
  return Object.keys(COMMAND_MODULES);
}

/**
 * Load all command definitions
 * 
 * @returns Map of command name to definition
 */
export async function loadAllCommands(): Promise<Map<string, CommandDefinition<any>>> {
  const commands = await getAvailableCommands();
  const definitions = new Map<string, CommandDefinition<any>>();
  
  for (const name of commands) {
    try {
      const command = await loadCommand(name);
      definitions.set(name, command);
    } catch (error) {
      // Skip commands that can't be loaded
      console.warn(`Warning: Could not load command '${name}': ${error}`);
    }
  }
  
  return definitions;
}

/**
 * Check if a command requires services
 * 
 * @param commandName - The command name
 * @returns True if the command requires services
 */
export async function commandRequiresServices(commandName: string): Promise<boolean> {
  try {
    const command = await loadCommand(commandName);
    return command.requiresServices === true;
  } catch {
    return false;
  }
}

/**
 * Check if a command requires an environment
 * 
 * @param commandName - The command name  
 * @returns True if the command requires an environment
 */
export async function commandRequiresEnvironment(commandName: string): Promise<boolean> {
  try {
    const command = await loadCommand(commandName);
    return command.requiresEnvironment === true;
  } catch {
    return false;
  }
}

/**
 * Type guard to check if an object is a CommandDefinition
 */
function isCommandDefinition(obj: any): obj is CommandDefinition<any> {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.name === 'string' &&
    typeof obj.description === 'string' &&
    obj.schema &&
    obj.argSpec &&
    typeof obj.handler === 'function'
  );
}

/**
 * Clear the command cache (useful for testing)
 */
export function clearCommandCache(): void {
  commandCache.clear();
}