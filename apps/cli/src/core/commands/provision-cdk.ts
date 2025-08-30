/**
 * CDK Stack Provisioning Module
 * 
 * Handles provisioning of AWS CDK stacks (data, app, infra) separately from
 * service-level provisioning. This supports the --stack option for the provision command.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { printError, printSuccess, printInfo, printWarning } from '../io/cli-logger.js';
import { loadEnvironmentConfig } from '../platform-resolver.js';
import { type EnvironmentConfig } from '../environment-config.js';
import { CommandResults } from './command-results.js';
import { ProvisionResult } from './provision.js';

export interface CdkProvisionOptions {
  stack: string; // 'data' | 'app' | 'infra' | 'all'
  environment: string;
  force?: boolean;
  destroy?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  requireApproval?: boolean;
}

/**
 * Provision CDK stacks for AWS deployment
 */
export async function provisionCdkStack(options: CdkProvisionOptions): Promise<CommandResults<ProvisionResult>> {
  const startTime = Date.now();
  const projectRoot = process.env.SEMIONT_ROOT || process.cwd();
  
  // Load environment config to get AWS settings
  const envConfig = loadEnvironmentConfig(options.environment) as EnvironmentConfig;
  
  if (!envConfig.aws) {
    throw new Error(`Environment ${options.environment} does not have AWS configuration`);
  }
  
  // Determine which stacks to deploy
  const stacksToProvision: string[] = [];
  const stackMapping: Record<string, string> = {
    'data': envConfig.aws.stacks?.data || 'SemiontDataStack',
    'app': envConfig.aws.stacks?.app || 'SemiontAppStack',
    'infra': envConfig.aws.stacks?.infra || 'SemiontInfraStack'
  };
  
  if (options.stack === 'all') {
    // Deploy in dependency order: data -> app
    if (stackMapping.data) stacksToProvision.push('data');
    if (stackMapping.app) stacksToProvision.push('app');
  } else if (stackMapping[options.stack]) {
    stacksToProvision.push(options.stack);
  } else {
    throw new Error(`Unknown stack type: ${options.stack}. Available: data, app, infra, all`);
  }
  
  const results: ProvisionResult[] = [];
  
  for (const stackType of stacksToProvision) {
    const stackName = stackMapping[stackType];
    
    if (!options.quiet) {
      if (options.destroy) {
        printWarning(`🗑️  Destroying ${stackName} stack...`);
      } else {
        printInfo(`🏗️  Provisioning ${stackName} stack...`);
      }
    }
    
    if (options.dryRun) {
      if (!options.quiet) {
        printInfo(`[DRY RUN] Would ${options.destroy ? 'destroy' : 'provision'} ${stackName}`);
      }
      
      results.push({
        entity: stackName,
        platform: 'aws',
        success: true,
        provisionTime: new Date(),
        dependencies: stackType === 'app' ? ['data'] : [],
        resources: {
          platform: 'aws',
          data: {
            region: envConfig.aws.region,
            stackName,
            stackType
          }
        },
        metadata: {
          dryRun: true,
          operation: options.destroy ? 'destroy' : 'deploy'
        }
      });
      continue;
    }
    
    try {
      // Prepare CDK context file
      const cdkContextPath = path.join(projectRoot, 'cdk.context.json');
      const cdkContext = fs.existsSync(cdkContextPath) 
        ? JSON.parse(fs.readFileSync(cdkContextPath, 'utf-8'))
        : {};
      
      // Update CDK context with environment-specific values
      cdkContext[`availability-zones:account=${envConfig.aws.accountId}:region=${envConfig.aws.region}`] = 
        cdkContext[`availability-zones:account=${envConfig.aws.accountId}:region=${envConfig.aws.region}`] || 
        [`${envConfig.aws.region}a`, `${envConfig.aws.region}b`];
      
      fs.writeFileSync(cdkContextPath, JSON.stringify(cdkContext, null, 2));
      
      // Build CDK command
      const cdkCommand = options.destroy ? 'destroy' : 'deploy';
      const cdkArgs = [
        cdkCommand,
        stackName,
        '--require-approval', options.requireApproval === false ? 'never' : 'broadening'
      ];
      
      if (options.force) {
        cdkArgs.push('--force');
      }
      
      if (!options.quiet && options.verbose) {
        printInfo(`Running: npx cdk ${cdkArgs.join(' ')}`);
        printInfo(`Stack: ${stackName} (${stackType})`);
        printInfo(`Region: ${envConfig.aws.region}`);
        printInfo(`Account: ${envConfig.aws.accountId}`);
      }
      
      // Execute CDK command
      execSync(`npx cdk ${cdkArgs.join(' ')}`, {
        cwd: projectRoot,
        stdio: options.verbose ? 'inherit' : 'pipe',
        env: {
          ...process.env,
          AWS_REGION: envConfig.aws.region,
          CDK_DEFAULT_ACCOUNT: envConfig.aws.accountId,
          CDK_DEFAULT_REGION: envConfig.aws.region,
          SEMIONT_ENV: options.environment
        }
      });
      
      if (!options.quiet) {
        if (options.destroy) {
          printSuccess(`✅ ${stackName} destroyed`);
        } else {
          printSuccess(`✅ ${stackName} provisioned`);
        }
      }
      
      results.push({
        entity: stackName,
        platform: 'aws',
        success: true,
        provisionTime: new Date(),
        dependencies: stackType === 'app' ? ['data'] : [],
        resources: {
          platform: 'aws',
          data: {
            region: envConfig.aws.region,
            accountId: envConfig.aws.accountId,
            stackName,
            stackType
          }
        },
        metadata: {
          operation: cdkCommand,
          stackName,
          stackType
        }
      });
      
    } catch (error) {
      if (!options.quiet) {
        printError(`Failed to ${options.destroy ? 'destroy' : 'provision'} ${stackName}: ${error}`);
      }
      
      results.push({
        entity: stackName,
        platform: 'aws',
        success: false,
        provisionTime: new Date(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  // Return command results
  return {
    command: 'provision',
    environment: options.environment,
    timestamp: new Date(),
    duration: Date.now() - startTime,
    results,
    summary: {
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      warnings: 0
    },
    executionContext: {
      user: process.env.USER || 'unknown',
      workingDirectory: process.cwd(),
      dryRun: options.dryRun || false
    }
  };
}