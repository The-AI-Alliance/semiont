/**
 * Init Command
 * 
 * Initializes a new Semiont project by creating configuration files and directory structure.
 * This command sets up the foundation for managing services across different environments
 * and platforms.
 * 
 * Workflow:
 * 1. Detects existing project structure
 * 2. Prompts for project configuration (interactive mode)
 * 3. Creates semiont.json project manifest
 * 4. Generates environment configuration files
 * 5. Creates directory structure for services
 * 6. Optionally initializes git repository
 * 
 * Options:
 * - --name: Project name
 * - --template: Use a specific project template
 * - --environments: Comma-separated list of environments to create
 * - --platform: Default platform for services
 * - --interactive: Run in interactive mode with prompts
 * - --force: Overwrite existing configuration
 * 
 * Created Structure:
 * - semiont.json: Main project configuration
 * - environments/: Environment-specific configurations
 * - services/: Service definitions and code
 * - state/: Runtime state storage (gitignored)
 * - backups/: Backup storage location (gitignored)
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { SemiontProject } from '@semiont/core/node';
import { colors } from '../io/cli-colors.js';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withBaseArgs } from '../base-options-schema.js';


// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

export const InitOptionsSchema = BaseOptionsSchema.extend({
  name: z.string().optional(),
  directory: z.string().optional(),
  force: z.boolean().default(false),
  environments: z.array(z.string()).default(['local', 'test', 'staging', 'production']),
}).transform((data) => ({
  ...data,
  environment: data.environment || '_init_', // Dummy value - init doesn't use environment
  output: data.output === 'table' ? 'summary' : data.output, // Init doesn't support table output
}));

export type InitOptions = z.output<typeof InitOptionsSchema>;

// =====================================================================
// HELPERS
// =====================================================================

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Create a minimal ~/.semiontconfig with a [user] section and a [environments.local] skeleton.
 */
function globalConfigTemplate(name: string, email: string): string {
  return `[user]
name = "${name}"
email = "${email}"

[defaults]
environment = "local"

[environments.local.backend]
port = 3001
publicURL = "http://localhost:3001"

[environments.local.frontend]
port = 3000
publicURL = "http://localhost:3000"

# Uncomment and fill in your inference provider credentials:
# [environments.local.inference]
# provider = "anthropic"
# apiKey = "\${ANTHROPIC_API_KEY}"

# Uncomment and fill in your database credentials:
# [environments.local.database]
# [environments.local.database.environment]
# POSTGRES_USER = "semiont"
# POSTGRES_PASSWORD = "\${POSTGRES_PASSWORD}"
# POSTGRES_DB = "semiont"
`;
}

/**
 * Ensure ~/.semiontconfig exists.
 * - If it already exists: do nothing, return false.
 * - If it does not exist: prompt for name/email, write template, return true.
 */
async function ensureGlobalConfig(quiet: boolean): Promise<boolean> {
  const configPath = path.join(os.homedir(), '.semiontconfig');
  if (fs.existsSync(configPath)) {
    if (!quiet) {
      console.log(`${colors.green}✓${colors.reset} ~/.semiontconfig already exists`);
    }
    return false;
  }

  console.log(`\n${colors.cyan}No ~/.semiontconfig found — creating one now.${colors.reset}`);

  const defaultName = process.env.USER || process.env.USERNAME || '';
  const nameAnswer = await prompt(`  Your name [${defaultName}]: `);
  const name = nameAnswer || defaultName;

  const emailAnswer = await prompt(`  Your email: `);
  const email = emailAnswer;

  fs.writeFileSync(configPath, globalConfigTemplate(name, email), 'utf-8');
  console.log(`${colors.green}✅ Created ~/.semiontconfig${colors.reset}`);
  return true;
}

// =====================================================================
// COMMAND IMPLEMENTATION
// =====================================================================

async function init(
  options: InitOptions
): Promise<CommandResults> {
  const startTime = Date.now();
  const projectDir = options.directory || process.cwd();
  const projectName = options.name || path.basename(projectDir);
  
  // Handle comma-separated environments string
  let environments = options.environments;
  if (environments.length === 1 && environments[0].includes(',')) {
    environments = environments[0].split(',').map(env => env.trim());
  }
  
  const results: CommandResults & { metadata?: any; error?: string } = {
    command: 'init',
    environment: 'none',
    timestamp: new Date(),
    duration: 0,
    results: [],
    summary: {
      total: 0,
      succeeded: 0,
      failed: 0,
      warnings: 0,
    },
    executionContext: {
      user: process.env.USER || 'unknown',
      workingDirectory: projectDir,
      dryRun: options.dryRun || false,
    },
  };
  
  try {
    // Check if already initialized
    const dotSemiontDir = path.join(projectDir, '.semiont');
    if (fs.existsSync(dotSemiontDir) && !options.force) {
      throw new Error('.semiont/ already exists. Use --force to overwrite.');
    }
    
    if (options.dryRun) {
      if (!options.quiet) {
        console.log(`${colors.cyan}[DRY RUN] Would create:${colors.reset}`);
        console.log(`  - .semiont/`);
        console.log(`  - .semiont/config`);
      }
      
      results.summary.succeeded = 1;
      results.metadata = {
        projectName,
        directory: projectDir,
        environments: environments,
        dryRun: true,
      };
    } else {
      // If --force, remove existing config so SemiontProject will write the new name
      const configPath = path.join(dotSemiontDir, 'config');
      if (options.force && fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }

      // Create .semiont/ anchor directory with minimal config
      new SemiontProject(projectDir, projectName);

      if (!options.quiet) {
        console.log(`${colors.green}✅ Created .semiont/${colors.reset}`);
      }

      // Ensure global config exists (prompts if missing)
      await ensureGlobalConfig(options.quiet);

      if (!options.quiet) {
        console.log(`\n${colors.bright}Project initialized successfully!${colors.reset}`);
        console.log(`\nNext steps:`);
        console.log(`  1. Edit ${colors.cyan}~/.semiontconfig${colors.reset} to add inference and database credentials`);
        console.log(`  2. Run '${colors.cyan}semiont provision${colors.reset}' to set up services`);
        console.log(`  3. Run '${colors.cyan}semiont start${colors.reset}' to launch all services`);
      }
      
      results.summary.succeeded = 1;
      results.metadata = {
        projectName,
        directory: projectDir,
        environments: environments,
        filesCreated: 1,
      };
    }
  } catch (error) {
    results.summary.failed = 1;
    results.error = error instanceof Error ? error.message : String(error);
    
    if (!options.quiet) {
      console.error(`${colors.red}❌ Failed to initialize project: ${results.error}${colors.reset}`);
    }
  }
  
  results.duration = Date.now() - startTime;
  return results;
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

// Export the handler function directly for tests
export { init };

export const initCommand = new CommandBuilder()
  .name('init')
  .description('Initialize a new Semiont project')
  .schema(InitOptionsSchema) // Schema types are compatible but TS can't infer it
  .args(withBaseArgs({
    '--name': {
      type: 'string',
      description: 'Project name',
    },
    '--directory': {
      type: 'string',
      description: 'Project directory',
    },
    '--force': {
      type: 'boolean',
      description: 'Overwrite existing configuration',
      default: false,
    },
    '--environments': {
      type: 'array',
      description: 'Comma-separated list of environments to create',
    },
  }, {
    '-n': '--name',
    '-d': '--directory',
    '-f': '--force',
  }))
  .requiresEnvironment(false)
  .requiresServices(false)
  .examples(
    'semiont init',
    'semiont init --name my-project',
    'semiont init --environments local,staging,production',
    'semiont init --directory ./my-app --force'
  )
  .setupHandler(init)
  .build();
