/**
 * Semiont CLI - Simplified entry point using dynamic command loader
 * 
 * This provides a unified entry point with:
 * - Dynamic command loading from command modules
 * - Type-safe argument parsing with Zod
 * - Consistent error handling and help generation
 */

import { getPreamble, getPreambleSeparator } from './core/io/cli-colors.js';
import { printError } from './core/io/cli-logger.js';
import { executeCommand as dynamicExecuteCommand, getAvailableCommands, generateGlobalHelp } from './core/command-loader.js';

// Get version from bundled package.json
// @ts-ignore - TypeScript doesn't like importing JSON, but esbuild handles it fine
const pkg = require('../package.json');
const VERSION = pkg.version || '0.0.1';

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================


function printVersion() {
  console.log(`Semiont CLI v${VERSION}`);
}

async function printHelp() {
  // Print preamble first
  console.log(getPreamble(VERSION));
  console.log(getPreambleSeparator());
  console.log();
  
  const help = await generateGlobalHelp();
  console.log(help);
}

// =====================================================================
// MAIN CLI HANDLER
// =====================================================================

async function main() {
  const args = process.argv.slice(2);
  
  // Handle no arguments
  if (args.length === 0) {
    await printHelp();
    process.exit(0);
  }
  
  // Handle global flags
  if (args[0] === '--version' || args[0] === '-v') {
    printVersion();
    process.exit(0);
  }
  
  if (args[0] === '--help' || args[0] === '-h') {
    await printHelp();
    process.exit(0);
  }
  
  // Extract command
  const command = args[0];
  
  // Check if it's a valid command
  const availableCommands = await getAvailableCommands();
  if (!command || !availableCommands.includes(command)) {
    printError(`Unknown command: ${command}`);
    console.log(`Available commands: ${availableCommands.join(', ')}`);
    console.log(`Run 'semiont --help' for more information.`);
    process.exit(1);
  }
  
  // Execute the command using the dynamic loader
  // The dynamic loader handles everything:
  // - Loading the command definition
  // - Parsing arguments with the command's schema
  // - Validating environment and services
  // - Executing the handler
  // - Formatting output
  // - Setting exit code
  await dynamicExecuteCommand(command, args.slice(1));
}

// Run the CLI
main().catch((error) => {
  printError(`Unexpected error: ${error.message}`);
  process.exit(1);
});