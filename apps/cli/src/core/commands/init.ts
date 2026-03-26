/**
 * Init Command
 *
 * Initializes a new Semiont project by creating .semiont/config and, if missing,
 * ~/.semiontconfig with user identity and service defaults.
 *
 * Workflow:
 * 1. Detects existing .semiont/ directory
 * 2. Creates .semiont/config (project identity and site config)
 * 3. Creates ~/.semiontconfig if it does not exist (prompts for user identity)
 *
 * Options:
 * - --name: Project name
 * - --directory: Project directory (defaults to cwd)
 * - --force: Overwrite existing .semiont/config
 *
 * Created Structure:
 * - .semiont/config: Project-local TOML config (name, version, site)
 * - ~/.semiontconfig: Global user TOML config (credentials, ports, service platforms)
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { execFileSync } from 'child_process';
import { SemiontProject } from '@semiont/core/node';
import { colors } from '../io/cli-colors.js';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { BaseOptionsSchema, withOpsArgs } from '../base-options-schema.js';
import { checkGitAvailable } from '../handlers/preflight-utils.js';


// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

export const InitOptionsSchema = BaseOptionsSchema.extend({
  name: z.string().optional(),
  directory: z.string().optional(),
  force: z.boolean().default(false),
  noGit: z.boolean().default(false),
  environments: z.array(z.string()).default(['local', 'test', 'staging', 'production']),
}).transform((data) => ({
  ...data,
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
 * Create the .semiont/config content for a new project.
 * Contains project identity and site configuration (project-specific, not user-specific).
 */
function projectConfigTemplate(projectName: string, gitSync: boolean): string {
  return `[project]
name = "${projectName}"
version = "0.1.0"

[git]
sync = ${gitSync}

[site]
domain = "localhost:8080"
siteName = "${projectName}"
adminEmail = ""
oauthAllowedDomains = ["example.com"]
`;
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
platform = "posix"
port = 4000
publicURL = "http://localhost:8080"

[environments.local.frontend]
platform = "posix"
port = 3000
publicURL = "http://localhost:8080"

[environments.local.proxy]
platform = "container"
port = 8080
publicURL = "http://localhost:8080"

[environments.local.graph]
platform = "external"
type = "neo4j"
name = "neo4j"
uri = "\${NEO4J_URI}"
username = "\${NEO4J_USERNAME}"
password = "\${NEO4J_PASSWORD}"
database = "\${NEO4J_DATABASE}"

[environments.local.inference.anthropic]
platform = "external"
endpoint = "https://api.anthropic.com"
apiKey = "\${ANTHROPIC_API_KEY}"

[environments.local.actors.gatherer.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.actors.matcher.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.workers.default.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.workers.reference-annotation.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.workers.highlight-annotation.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"

[environments.local.workers.assessment-annotation.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.workers.comment-annotation.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"

[environments.local.workers.tag-annotation.inference]
type = "anthropic"
model = "claude-haiku-4-5-20251001"

[environments.local.workers.generation.inference]
type = "anthropic"
model = "claude-sonnet-4-5-20250929"

[environments.local.database]
platform = "container"
image = "postgres:15-alpine"
host = "localhost"
port = 5432
name = "semiont"
user = "postgres"
password = "\${POSTGRES_PASSWORD}"
`;
}

/**
 * Ensure ~/.semiontconfig exists.
 * - If it already exists: do nothing, return false.
 * - If it does not exist: prompt for name/email, write template, return true.
 */
export async function ensureGlobalConfig(quiet: boolean): Promise<boolean> {
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
    
    const noGit = options.noGit;

    if (options.dryRun) {
      if (!options.quiet) {
        console.log(`${colors.cyan}[DRY RUN] Would create:${colors.reset}`);
        console.log(`  - .semiont/`);
        console.log(`  - .semiont/config  (git.sync = ${!noGit})`);
        if (!noGit) {
          console.log(`  - git init`);
          console.log(`  - git add .semiont/config`);
        }
      }

      results.summary.succeeded = 1;
      results.metadata = {
        projectName,
        directory: projectDir,
        environments: environments,
        dryRun: true,
      };
    } else {
      // When --no-git: emit implications before writing anything
      if (noGit && !options.quiet) {
        console.log(`${colors.yellow}ℹ --no-git: git init will be skipped${colors.reset}`);
        console.log(`${colors.yellow}ℹ --no-git: git.sync will be set to false in .semiont/config${colors.reset}`);
        console.log(`${colors.yellow}ℹ --no-git: .semiont/config will NOT be staged (git add skipped)${colors.reset}`);
        console.log(`${colors.yellow}ℹ --no-git: semiont yield/mv will not stage files in the git index${colors.reset}`);
      }

      // Write .semiont/config with project identity and site skeleton
      const dotSemiontConfigPath = path.join(dotSemiontDir, 'config');
      if (!fs.existsSync(dotSemiontDir) || options.force) {
        fs.mkdirSync(dotSemiontDir, { recursive: true });
        fs.writeFileSync(dotSemiontConfigPath, projectConfigTemplate(projectName, !noGit));
      }

      // Run git init and stage .semiont/config unless --no-git
      if (!noGit) {
        const gitCheck = checkGitAvailable();
        if (!gitCheck.pass) {
          if (!options.quiet) {
            console.log(`${colors.yellow}⚠ git not available — skipping git init and git add .semiont/config${colors.reset}`);
          }
        } else {
          // git init (idempotent — safe to run in an existing repo)
          execFileSync('git', ['init'], { cwd: projectDir });
          if (!options.quiet) {
            console.log(`${colors.green}✓${colors.reset} git init`);
          }

          execFileSync('git', ['add', dotSemiontConfigPath], { cwd: projectDir });
          if (!options.quiet) {
            console.log(`${colors.green}✓${colors.reset} git add .semiont/config`);
          }
        }
      }

      // Construct SemiontProject to set up ephemeral XDG dirs
      new SemiontProject(projectDir);

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
        gitSync: !noGit,
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
  .args(withOpsArgs({
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
    '--no-git': {
      type: 'boolean',
      description: 'Disable git sync (sets git.sync=false in config, skips git add)',
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
