/**
 * Init Command - Initialize a new Semiont project
 * 
 * Creates semiont.json and starter environment configurations
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { colors } from '../lib/cli-colors.js';
import { CommandResults } from '../lib/command-results.js';

// =====================================================================
// SCHEMA DEFINITIONS
// =====================================================================

const InitOptionsSchema = z.object({
  name: z.string().optional(),
  directory: z.string().optional(),
  force: z.boolean().default(false),
  environments: z.array(z.string()).default(['local', 'test', 'staging', 'production']),
  output: z.enum(['summary', 'json', 'yaml']).default('summary'),
  quiet: z.boolean().default(false),
  verbose: z.boolean().default(false),
});

type InitOptions = z.infer<typeof InitOptionsSchema>;

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
    oauthAllowedDomains?: string[];
  };
  defaults?: {
    region?: string;
    deployment?: {
      type: string;
    };
    services?: Record<string, any>;
  };
}

function generateSemiontJson(projectName: string): SemiontConfig {
  return {
    version: "1.0",
    project: projectName,
    site: {
      siteName: projectName,
      domain: `${projectName.toLowerCase()}.example.com`,
      adminEmail: "admin@example.com",
      supportEmail: "support@example.com",
      oauthAllowedDomains: ["example.com"]
    },
    defaults: {
      region: "us-east-1",
      deployment: {
        type: "container"
      },
      services: {
        frontend: {
          port: 3000
        },
        backend: {
          port: 3001
        },
        database: {
          port: 5432,
          user: "postgres"
        }
      }
    }
  };
}

function generateEnvironmentConfig(environment: string): any {
  const configs: Record<string, any> = {
    local: {
      _comment: "Local development environment",
      deployment: {
        default: "process"
      },
      env: {
        NODE_ENV: "development"
      },
      services: {
        frontend: {
          command: "npm run dev"
        },
        backend: {
          command: "npm run dev"
        },
        database: {
          deployment: {
            type: "container"
          },
          image: "postgres:15-alpine",
          name: "semiont_local",
          password: "localpass"
        }
      }
    },
    test: {
      _comment: "Test environment for automated testing",
      deployment: {
        default: "mock"
      },
      env: {
        NODE_ENV: "test"
      },
      services: {
        frontend: {
          command: "npm test"
        },
        backend: {
          command: "npm test"
        },
        database: {
          deployment: {
            type: "mock"
          }
        }
      }
    },
    staging: {
      _comment: "Staging environment - pre-production testing",
      deployment: {
        default: "aws"
      },
      env: {
        NODE_ENV: "production"
      },
      aws: {
        accountId: "123456789012",
        stacks: {
          infra: "semiont-staging-infra",
          app: "semiont-staging-app"
        },
        database: {
          instanceClass: "db.t3.small",
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
        database: {
          name: "semiont_staging"
        }
      }
    },
    production: {
      _comment: "Production environment",
      deployment: {
        default: "aws"
      },
      env: {
        NODE_ENV: "production"
      },
      aws: {
        accountId: "987654321098",
        stacks: {
          infra: "semiont-prod-infra",
          app: "semiont-prod-app"
        },
        database: {
          instanceClass: "db.t3.medium",
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
        database: {
          name: "semiont_production"
        }
      }
    }
  };

  return configs[environment] || {
    _comment: `Custom environment: ${environment}`,
    deployment: {
      default: "container"
    },
    env: {
      NODE_ENV: "development"
    },
    services: {}
  };
}

// =====================================================================
// HELPER FUNCTIONS
// =====================================================================

function printError(message: string): void {
  console.error(`${colors.red}❌ ${message}${colors.reset}`);
}

function printSuccess(message: string): void {
  console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function printInfo(message: string): void {
  console.log(`${colors.cyan}ℹ️  ${message}${colors.reset}`);
}

function printWarning(message: string): void {
  console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`);
}

// =====================================================================
// INIT FUNCTION
// =====================================================================

export async function init(options: InitOptions): Promise<CommandResults> {
  const startTime = Date.now();
  const projectName = options.name || path.basename(process.cwd());
  const targetDir = options.directory || process.cwd();
  const configPath = path.join(targetDir, 'semiont.json');
  
  try {
    // Check if semiont.json already exists
    if (fs.existsSync(configPath) && !options.force) {
      throw new Error(`semiont.json already exists. Use --force to overwrite.`);
    }

    if (!options.quiet) {
      printInfo(`Initializing Semiont project: ${projectName}`);
      printInfo(`Environments: ${options.environments.join(', ')}`);
    }

    // Create semiont.json
    const semiontConfig = generateSemiontJson(projectName);
    fs.writeFileSync(
      configPath,
      JSON.stringify(semiontConfig, null, 2)
    );

    if (!options.quiet) {
      printSuccess(`Created semiont.json`);
    }

    // Create config/environments directory
    const envDir = path.join(targetDir, 'config', 'environments');
    fs.mkdirSync(envDir, { recursive: true });

    // Create environment configs
    const createdFiles: string[] = ['semiont.json'];
    for (const env of options.environments) {
      const envConfig = generateEnvironmentConfig(env);
      const envPath = path.join(envDir, `${env}.json`);
      fs.writeFileSync(
        envPath,
        JSON.stringify(envConfig, null, 2)
      );
      createdFiles.push(`config/environments/${env}.json`);
      
      if (!options.quiet && options.verbose) {
        printSuccess(`Created config/environments/${env}.json`);
      }
    }

    if (!options.quiet) {
      printSuccess(`Created ${options.environments.length} environment configurations`);
      console.log('');
      printInfo('Next steps:');
      console.log(`  1. Edit semiont.json to configure your site settings`);
      console.log(`  2. Customize config/environments/*.json for each environment`);
      console.log(`  3. Run: semiont provision --environment local`);
    }

    // Return structured results
    return {
      command: 'init',
      environment: 'none',
      timestamp: new Date(),
      duration: Date.now() - startTime,
      services: [],  // Init doesn't operate on services
      summary: {
        total: 1,
        succeeded: 1,
        failed: 0,
        warnings: 0
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: false
      },
      metadata: {
        projectName,
        targetDirectory: targetDir,
        createdFiles,
        environments: options.environments
      }
    };

  } catch (error) {
    if (!options.quiet) {
      printError(`Failed to initialize project: ${error}`);
    }

    return {
      command: 'init',
      environment: 'none',
      timestamp: new Date(),
      duration: Date.now() - startTime,
      services: [],  // Init doesn't operate on services
      summary: {
        total: 1,
        succeeded: 0,
        failed: 1,
        warnings: 0
      },
      executionContext: {
        user: process.env.USER || 'unknown',
        workingDirectory: process.cwd(),
        dryRun: false
      },
      metadata: {
        error: error instanceof Error ? error.message : String(error),
        projectName,
        targetDirectory: targetDir
      }
    };
  }
}

// =====================================================================
// MAIN EXECUTION
// =====================================================================

export async function main(options: InitOptions): Promise<void> {
  try {
    const results = await init(options);
    
    // Handle structured output
    if (options.output !== 'summary') {
      const { formatResults } = await import('../lib/output-formatter.js');
      const formatted = formatResults(results, options.output);
      console.log(formatted);
      return;
    }
    
    // Exit with appropriate code
    if (results.summary.failed > 0) {
      process.exit(1);
    }
    
  } catch (error) {
    printError(`Init failed: ${error}`);
    process.exit(1);
  }
}

export { InitOptions, InitOptionsSchema };