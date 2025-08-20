/**
 * Init Command - Initialize a new Semiont project (v2)
 * 
 * Creates semiont.json and starter environment configurations
 * This is the migrated version using the new command definition structure.
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
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

interface SemiontConfig {
  version: string;
  project: string;
  site: {
    siteName: string;
    domain: string;
    adminEmail: string;
    supportEmail?: string;
  };
  services: {
    frontend: {
      framework: string;
      port: number;
    };
    backend: {
      framework: string;
      port: number;
    };
    database: {
      type: string;
      port: number;
    };
  };
}

/**
 * Generate starter template for the main semiont.json file.
 * This is just an example configuration that users should customize.
 * 
 * @param projectName - Name of the project
 * @returns Starter configuration object to be serialized as JSON
 */
function getStarterProjectTemplate(projectName: string): SemiontConfig {
  return {
    version: '1.0.0',
    project: projectName,
    site: {
      siteName: projectName,
      domain: 'example.com',
      adminEmail: 'admin@example.com',
    },
    services: {
      frontend: {
        framework: 'next',
        port: 3000,
      },
      backend: {
        framework: 'express',
        port: 3001,
      },
      database: {
        type: 'postgres',
        port: 5432,
      },
    },
  };
}

/**
 * Generate starter template for environment configuration files.
 * These are just example defaults that users should customize.
 * 
 * @param envName - Name of the environment
 * @returns Starter configuration object to be serialized as JSON
 */
function getStarterEnvironmentTemplate(envName: string) {
  const templates: Record<string, any> = {
    local: {
      _comment: 'Local development environment',
      deployment: {
        default: 'process'
      },
      env: {
        NODE_ENV: 'development'
      },
      services: {
        frontend: {
          command: 'npm run dev'
        },
        backend: {
          command: 'npm run dev'
        },
        database: {
          deployment: {
            type: 'container'
          },
          image: 'postgres:15-alpine',
          name: 'semiont_local',
          password: 'localpass'
        },
        filesystem: {
          deployment: {
            type: 'process'
          },
          path: './data'
        }
      }
    },
    test: {
      _comment: 'Test environment',
      deployment: {
        default: 'container'
      },
      env: {
        NODE_ENV: 'test'
      },
      services: {
        database: {
          deployment: {
            type: 'container'
          },
          image: 'postgres:15-alpine',
          name: 'semiont_test',
          password: 'testpass'
        },
        filesystem: {
          deployment: {
            type: 'process'
          },
          path: './test-data'
        }
      }
    },
    staging: {
      _comment: 'Staging environment - pre-production testing',
      deployment: {
        default: 'aws'
      },
      env: {
        NODE_ENV: 'production'
      },
      aws: {
        region: 'us-east-1',
        accountId: '123456789012',
        stacks: {
          infra: 'SemiontInfraStack',
          app: 'SemiontAppStack'
        },
        database: {
          instanceClass: 'db.t3.small',
          multiAZ: false,
          backupRetentionDays: 7
        },
        ecs: {
          desiredCount: 1,
          minCapacity: 1,
          maxCapacity: 2
        }
      },
      services: {
        frontend: {
          deployment: {
            type: 'aws'
          },
          port: 3000
        },
        backend: {
          deployment: {
            type: 'aws'
          },
          port: 3001
        },
        database: {
          name: 'semiont_staging'
        },
        filesystem: {
          deployment: {
            type: 'aws'
          },
          path: '/mnt/efs/staging'
        }
      }
    },
    production: {
      _comment: 'Production environment',
      deployment: {
        default: 'aws'
      },
      env: {
        NODE_ENV: 'production'
      },
      aws: {
        region: 'us-east-1',
        accountId: '987654321098',
        stacks: {
          infra: 'SemiontInfraStack',
          app: 'SemiontAppStack'
        },
        database: {
          instanceClass: 'db.t3.medium',
          multiAZ: true,
          backupRetentionDays: 30
        },
        ecs: {
          desiredCount: 2,
          minCapacity: 2,
          maxCapacity: 10
        },
        monitoring: {
          enableDetailedMonitoring: true,
          logRetentionDays: 90
        }
      },
      services: {
        frontend: {
          deployment: {
            type: 'aws'
          },
          port: 3000
        },
        backend: {
          deployment: {
            type: 'aws'
          },
          port: 3001
        },
        database: {
          name: 'semiont_production'
        },
        filesystem: {
          deployment: {
            type: 'aws'
          },
          path: '/mnt/efs/production'
        }
      }
    }
  };
  
  // Return predefined template or a generic process-based starter
  return templates[envName] || {
    _comment: `${envName} environment`,
    deployment: {
      default: 'process'
    },
    env: {
      NODE_ENV: envName
    },
    services: {}
  };
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
        console.log(`  - config/environments/`);
        environments.forEach(env => {
          console.log(`    - ${env}.json`);
        });
      }
      
      results.summary.succeeded = 1;
      results.metadata = {
        projectName,
        directory: projectDir,
        environments: environments,
        dryRun: true,
      };
    } else {
      // Create semiont.json with starter template
      const config = getStarterProjectTemplate(projectName);
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      
      if (!options.quiet) {
        console.log(`${colors.green}✅ Created semiont.json${colors.reset}`);
      }
      
      // Create environment configs
      const envDir = path.join(projectDir, 'config', 'environments');
      fs.mkdirSync(envDir, { recursive: true });
      
      for (const envName of environments) {
        const envConfig = getStarterEnvironmentTemplate(envName);
        const envPath = path.join(envDir, `${envName}.json`);
        fs.writeFileSync(envPath, JSON.stringify(envConfig, null, 2));
        
        if (!options.quiet) {
          console.log(`${colors.green}✅ Created config/environments/${envName}.json${colors.reset}`);
        }
      }
      
      if (!options.quiet) {
        console.log(`\n${colors.bright}🚀 Project initialized successfully!${colors.reset}`);
        console.log(`\nNext steps:`);
        console.log(`  1. Review and customize semiont.json`);
        console.log(`  2. Configure your environments in config/environments/`);
        console.log(`  3. Run 'semiont provision -e local' to set up local development`);
      }
      
      results.summary.succeeded = 1;
      results.metadata = {
        projectName,
        directory: projectDir,
        environments: environments,
        filesCreated: 1 + environments.length,
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