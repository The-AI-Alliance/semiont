/**
 * Init Command - Initialize a new Semiont project (v2)
 * 
 * Creates semiont.json and starter environment configurations
 * This is the migrated version using the new command definition structure.
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { colors } from '../lib/cli-colors.js';
import { CommandResults } from '../lib/command-results.js';
import { CommandBuilder } from '../lib/command-definition.js';
import { type ServiceDeploymentInfo } from '../lib/deployment-resolver.js';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

export const InitOptionsSchema = z.object({
  environment: z.string().default('_init_'), // Dummy value - init doesn't use environment
  name: z.string().optional(),
  directory: z.string().optional(),
  force: z.boolean().default(false),
  environments: z.array(z.string()).default(['local', 'test', 'staging', 'production']),
  output: z.enum(['summary', 'json', 'yaml']).default('summary'),
  quiet: z.boolean().default(false),
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

export type InitOptions = z.infer<typeof InitOptionsSchema>;

// =====================================================================
// TEMPLATE CONFIGURATIONS
// =====================================================================

// Get the templates directory path
function getTemplatesDir(): string {
  // Allow tests to override the template directory
  if (process.env.SEMIONT_TEMPLATES_DIR) {
    return process.env.SEMIONT_TEMPLATES_DIR;
  }
  
  // Production path: templates are at ../templates relative to the command
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, '..', 'templates');
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
  _serviceDeployments: ServiceDeploymentInfo[], // Not used by init
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
    services: [],
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
        console.log(`    - infra-stack.ts`);
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
        // Use the appropriate template for each environment type
        let templateName = 'production.json';
        if (envName === 'local') {
          templateName = 'local.json';
        } else if (envName === 'test') {
          templateName = 'test.json';
        } else if (envName === 'staging') {
          templateName = 'staging.json';
        }
        
        // Check if template exists, fallback to production template
        const templatesDir = getTemplatesDir();
        const templatePath = path.join(templatesDir, 'environments', templateName);
        if (!fs.existsSync(templatePath)) {
          templateName = 'production.json';
        }
        
        copyTemplate(`environments/${templateName}`, path.join(envDir, `${envName}.json`), {
          'production': envName,
          'staging': envName,
          'YOUR_AWS_ACCOUNT_ID': '123456789012',  // Placeholder
          'YOUR_HOSTED_ZONE_ID': 'Z1234567890ABC',  // Placeholder
          'YOUR_CERT_ID': 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'  // Placeholder
        });
        
        if (!options.quiet) {
          console.log(`${colors.green}✅ Created environments/${envName}.json${colors.reset}`);
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

export const initCommand = new CommandBuilder<InitOptions>()
  .name('init')
  .description('Initialize a new Semiont project')
  .schema(InitOptionsSchema as any) // Schema types are compatible but TS can't infer it
  .args({
    args: {
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
      '--output': {
        type: 'string',
        description: 'Output format',
        choices: ['summary', 'json', 'yaml'],
        default: 'summary',
      },
      '--quiet': {
        type: 'boolean',
        description: 'Suppress output except errors',
        default: false,
      },
      '--verbose': {
        type: 'boolean',
        description: 'Verbose output',
        default: false,
      },
      '--dry-run': {
        type: 'boolean',
        description: 'Preview changes without creating files',
        default: false,
      },
    },
    aliases: {
      '-n': '--name',
      '-d': '--directory',
      '-f': '--force',
      '-o': '--output',
      '-q': '--quiet',
      '-v': '--verbose',
    },
  })
  .requiresEnvironment(false)
  .requiresServices(false)
  .examples(
    'semiont init',
    'semiont init --name my-project',
    'semiont init --environments local,staging,production',
    'semiont init --directory ./my-app --force'
  )
  .handler(init)
  .build();

// Also export as default for compatibility
export default initCommand;