/**
 * Semiont Installation Script - TypeScript replacement for install_semiont.sh
 * 
 * This script builds the entire monorepo and installs the Semiont CLI globally.
 * 
 * Usage:
 *   npm run install              # Full installation
 *   npm run install -- --cli-only   # CLI tools only
 *   npm run install -- --help       # Show help
 */

import { z } from 'zod';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SemiontInstaller } from './lib/installer.js';
import { ProgressReporter } from './lib/progress-reporter.js';
import { EnvironmentValidator } from './lib/environment-validator.js';

// Get directory paths (ES modules compatible)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

// =====================================================================
// ARGUMENT PARSING WITH ZOD
// =====================================================================

const InstallOptionsSchema = z.object({
  cliOnly: z.boolean().default(false),
  verbose: z.boolean().default(false),
  help: z.boolean().default(false),
});

type InstallOptions = z.infer<typeof InstallOptionsSchema>;

// =====================================================================
// ARGUMENT PARSING
// =====================================================================

function parseArgs(): InstallOptions {
  const args = process.argv.slice(2);
  
  let cliOnly = false;
  let verbose = false;
  let help = false;

  for (const arg of args) {
    switch (arg) {
      case '--cli-only':
        cliOnly = true;
        break;
      case '--verbose':
      case '-v':
        verbose = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
    }
  }

  try {
    return InstallOptionsSchema.parse({ cliOnly, verbose, help });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Invalid arguments:');
      for (const issue of error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

function printHelp(): void {
  console.log(`
🚀 Semiont Installation Script
================================

Usage: npm run install [OPTIONS]

Options:
  --cli-only    Build and install only the CLI tools
  --verbose     Show detailed build output
  --help, -h    Show this help message

Default behavior (no options):
  • Install all dependencies
  • Build all packages (api-types, config-loader, backend, frontend, cli)
  • Install the semiont CLI globally

Examples:
  npm run install              # Full installation
  npm run install -- --cli-only   # CLI tools only
  npm run install -- --verbose    # Detailed output

After installation:
  semiont provision -e local   # Setup local environment
  semiont start -e local       # Start services
  semiont --help               # Show all CLI commands
`);
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

async function main(): Promise<void> {
  const options = parseArgs();
  
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  const reporter = new ProgressReporter(options.verbose);
  
  try {
    // Show installation banner
    reporter.showBanner(options.cliOnly);
    
    // Validate environment
    const validator = new EnvironmentValidator(PROJECT_ROOT, reporter);
    await validator.validate();
    
    // Run installation
    const installer = new SemiontInstaller(PROJECT_ROOT, reporter);
    await installer.install(options.cliOnly);
    
    // Show success summary
    reporter.showSuccessSummary();
    
  } catch (error) {
    reporter.showError('Installation failed', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('❌ Unexpected error:', error);
    process.exit(1);
  });
}

export { main };
export type { InstallOptions };
export { InstallOptionsSchema };