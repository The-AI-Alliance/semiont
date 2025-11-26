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
import * as path from 'path';
import { fileURLToPath } from 'url';
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
// TEMPLATE CONFIGURATIONS
// =====================================================================

// Get the templates directory path
function getTemplatesDir(): string {
  // Allow tests to override the template directory
  if (process.env.SEMIONT_TEMPLATES_DIR) {
    return process.env.SEMIONT_TEMPLATES_DIR;
  }
  
  // Check if we're running from source (tests) or dist (production)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  
  // If we're in src/core/commands, go up to find templates
  if (__dirname.includes(path.sep + 'src' + path.sep)) {
    // Running from source: go up 3 levels to project root, then to templates
    return path.join(__dirname, '..', '..', '..', 'templates');
  } else {
    // Production path: templates are at ../templates relative to the command
    return path.join(__dirname, '..', 'templates');
  }
}

// Copy template file or directory
function copyTemplate(source: string, dest: string, replacements?: Record<string, string>): void {
  const templatesDir = getTemplatesDir();
  const sourcePath = path.join(templatesDir, source);
  
  if (fs.statSync(sourcePath).isDirectory()) {
    // Create destination directory
    fs.mkdirSync(dest, { recursive: true });
    
    // Copy all files in directory
    const files = fs.readdirSync(sourcePath);
    for (const file of files) {
      copyTemplate(path.join(source, file), path.join(dest, file), replacements);
    }
  } else {
    // Copy file
    let content = fs.readFileSync(sourcePath, 'utf8');
    
    // Apply replacements if provided
    if (replacements) {
      for (const [key, value] of Object.entries(replacements)) {
        content = content.replace(new RegExp(key, 'g'), value);
      }
    }
    
    // Ensure destination directory exists
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
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
    // Check if semiont.json already exists
    const configPath = path.join(projectDir, 'semiont.json');
    if (fs.existsSync(configPath) && !options.force) {
      throw new Error('semiont.json already exists. Use --force to overwrite.');
    }
    
    if (options.dryRun) {
      if (!options.quiet) {
        console.log(`${colors.cyan}[DRY RUN] Would create:${colors.reset}`);
        console.log(`  - semiont.json`);
        console.log(`  - environments/`);
        environments.forEach(env => {
          console.log(`    - ${env}.json`);
        });
        console.log(`  - cdk/`);
        console.log(`    - data-stack.ts`);
        console.log(`    - app-stack.ts`);
      }
      
      results.summary.succeeded = 1;
      results.metadata = {
        projectName,
        directory: projectDir,
        environments: environments,
        dryRun: true,
      };
    } else {
      // Copy semiont.json template
      copyTemplate('semiont.json', path.join(projectDir, 'semiont.json'), {
        'my-semiont-project': projectName
      });
      
      if (!options.quiet) {
        console.log(`${colors.green}✅ Created semiont.json${colors.reset}`);
      }
      
      // Copy environment templates
      const envDir = path.join(projectDir, 'environments');
      fs.mkdirSync(envDir, { recursive: true });
      
      for (const envName of environments) {
        // Copy the environment template if it exists, otherwise skip
        const templatesDir = getTemplatesDir();
        const templatePath = path.join(templatesDir, 'environments', `${envName}.json`);

        if (fs.existsSync(templatePath)) {
          copyTemplate(`environments/${envName}.json`, path.join(envDir, `${envName}.json`));

          if (!options.quiet) {
            console.log(`${colors.green}✅ Created environments/${envName}.json${colors.reset}`);
          }
        } else {
          if (!options.quiet) {
            console.log(`${colors.yellow}⚠️  No template for environment '${envName}', skipped${colors.reset}`);
          }
        }
      }
      
      // Copy all template files
      copyTemplate('cdk', path.join(projectDir, 'cdk'));
      copyTemplate('package.json', path.join(projectDir, 'package.json'));
      copyTemplate('tsconfig.json', path.join(projectDir, 'tsconfig.json'));
      copyTemplate('cdk.json', path.join(projectDir, 'cdk.json'));
      
      if (!options.quiet) {
        console.log(`${colors.green}✅ Created CDK infrastructure files${colors.reset}`);
        console.log(`${colors.dim}   Run 'npm install' to install dependencies${colors.reset}`);
      }
      
      if (!options.quiet) {
        console.log(`\n${colors.bright}🚀 Project initialized successfully!${colors.reset}`);
        console.log(`\nNext steps:`);
        console.log(`  1. Review and customize semiont.json`);
        console.log(`  2. Configure your environments in environments/`);
        console.log(`  3. ${colors.yellow}[AWS Only]${colors.reset} Customize CDK stacks in cdk/ with your AWS settings`);
        console.log(`  4. ${colors.yellow}[AWS Only]${colors.reset} Install CDK dependencies: npm install aws-cdk-lib constructs`);
        console.log(`  5. Run 'semiont provision -e local' to set up local development`);
      }
      
      results.summary.succeeded = 1;
      results.metadata = {
        projectName,
        directory: projectDir,
        environments: environments,
        filesCreated: 1 + environments.length + 2, // semiont.json + env files + 2 CDK files
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
