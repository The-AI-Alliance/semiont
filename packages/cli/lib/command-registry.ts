/**
 * Command Registry - Central registry of all CLI commands
 * 
 * This module maintains a registry of all commands that follow
 * the standard CommandFunction signature.
 */

import { CommandFunction, BaseCommandOptions, CommandRegistryEntry } from './command-types.js';

/**
 * Registry of all CLI commands
 * Each command follows the standard (ServiceDeploymentInfo[], options) -> CommandResults pattern
 */
export const COMMANDS = {
  // Infrastructure and deployment commands
  init: {
    name: 'init',
    description: 'Initialize a new Semiont project',
    requiresServices: false,
  },
  provision: {
    name: 'provision',
    description: 'Provision infrastructure (containers or cloud)',
    requiresServices: true,
  },
  configure: {
    name: 'configure',
    description: 'Manage configuration and secrets',
    requiresServices: false, // Configure doesn't actually use services but follows the pattern
  },
  
  // Service lifecycle commands
  start: {
    name: 'start',
    description: 'Start services in any environment',
    requiresServices: true,
  },
  stop: {
    name: 'stop',
    description: 'Stop services in any environment',
    requiresServices: true,
  },
  restart: {
    name: 'restart',
    description: 'Restart services in any environment',
    requiresServices: true,
  },
  
  // Deployment and publishing commands
  publish: {
    name: 'publish',
    description: 'Build and push container images',
    requiresServices: true,
  },
  update: {
    name: 'update',
    description: 'Update running services with pre-built images',
    requiresServices: true,
  },
  
  // Monitoring and operations commands
  check: {
    name: 'check',
    description: 'Check system health and status',
    requiresServices: true,
  },
  watch: {
    name: 'watch',
    description: 'Monitor logs and system metrics',
    requiresServices: true,
  },
  test: {
    name: 'test',
    description: 'Run tests against environments',
    requiresServices: true,
  },
  
  // Utility commands
  backup: {
    name: 'backup',
    description: 'Create database backups',
    requiresServices: true,
  },
  exec: {
    name: 'exec',
    description: 'Execute commands in cloud containers',
    requiresServices: true,
  },
} as const;

/**
 * Type guard to check if a command exists in the registry
 */
export function isRegisteredCommand(commandName: string): commandName is keyof typeof COMMANDS {
  return commandName in COMMANDS;
}

/**
 * Get command metadata
 */
export function getCommandMetadata(commandName: string) {
  if (isRegisteredCommand(commandName)) {
    return COMMANDS[commandName];
  }
  return null;
}

/**
 * Get all commands that require service resolution
 */
export function getServiceCommands(): Array<keyof typeof COMMANDS> {
  return (Object.keys(COMMANDS) as Array<keyof typeof COMMANDS>)
    .filter(cmd => COMMANDS[cmd].requiresServices);
}

/**
 * Get all commands that don't require service resolution
 */
export function getStandaloneCommands(): Array<keyof typeof COMMANDS> {
  return (Object.keys(COMMANDS) as Array<keyof typeof COMMANDS>)
    .filter(cmd => !COMMANDS[cmd].requiresServices);
}

/**
 * Validate that a command module exports the expected function
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