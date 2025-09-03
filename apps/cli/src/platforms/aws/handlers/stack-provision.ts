import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { AWSProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printError, printSuccess, printInfo, printWarning } from '../../../core/io/cli-logger.js';
import { loadEnvironmentConfig } from '../../../core/platform-resolver.js';

/**
 * Provision handler for AWS CDK stacks
 * 
 * Handles provisioning of AWS infrastructure stacks (data, app) using CDK.
 * This is infrastructure-level provisioning, not service-level.
 * 
 * Stack types:
 * - 'data': Stateful resources (RDS, EFS, S3)
 * - 'app': Application resources (ECS, ALB, services)
 * - 'all': Both stacks in dependency order
 */
const provisionStackService = async (context: AWSProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, awsConfig } = context;
  
  // Extract stack configuration from service
  const stackType = service.config?.stackType || 'all'; // 'data' | 'app' | 'all'
  const destroy = service.config?.destroy || false;
  const force = service.config?.force || false;
  const requireApproval = service.config?.requireApproval ?? true;
  
  // Always use the actual project root (user's project), not semiont-repo
  // When --semiont-repo is used, service.projectRoot incorrectly points to the semiont repo
  // We need to use the actual user's project directory where semiont.json lives
  const projectRoot = process.env.SEMIONT_ROOT || process.cwd();
  const environment = service.environment;
  
  // Load environment config to get AWS settings
  const envConfig = loadEnvironmentConfig(environment);
  
  if (!envConfig.aws) {
    return {
      success: false,
      error: `Environment ${environment} does not have AWS configuration`,
      metadata: {
        serviceType: 'stack'
      }
    };
  }
  
  // Determine which stacks to deploy
  const stacksToProvision: string[] = [];
  const stackMapping: Record<string, string> = {
    'data': envConfig.aws.stacks?.data || 'SemiontDataStack',
    'app': envConfig.aws.stacks?.app || 'SemiontAppStack'
  };
  
  if (stackType === 'all') {
    // Deploy in dependency order: data -> app
    if (stackMapping.data) stacksToProvision.push('data');
    if (stackMapping.app) stacksToProvision.push('app');
  } else if (stackMapping[stackType]) {
    stacksToProvision.push(stackType);
  } else {
    return {
      success: false,
      error: `Unknown stack type: ${stackType}. Available: data, app, all`,
      metadata: {
        serviceType: 'stack'
      }
    };
  }
  
  const results: any[] = [];
  let allSuccessful = true;
  
  for (const currentStackType of stacksToProvision) {
    const stackName = stackMapping[currentStackType];
    
    if (!service.quiet) {
      if (destroy) {
        printWarning(`🗑️  Destroying ${stackName} stack...`);
      } else {
        printInfo(`🏗️  Provisioning ${stackName} stack...`);
      }
    }
    
    if (service.dryRun) {
      if (!service.quiet) {
        printInfo(`[DRY RUN] Would ${destroy ? 'destroy' : 'provision'} ${stackName}`);
      }
      
      results.push({
        stackName,
        stackType: currentStackType,
        success: true,
        dryRun: true,
        operation: destroy ? 'destroy' : 'deploy'
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
      cdkContext[`availability-zones:account=${awsConfig.accountId}:region=${awsConfig.region}`] = 
        cdkContext[`availability-zones:account=${awsConfig.accountId}:region=${awsConfig.region}`] || 
        [`${awsConfig.region}a`, `${awsConfig.region}b`];
      
      fs.writeFileSync(cdkContextPath, JSON.stringify(cdkContext, null, 2));
      
      // Build CDK command
      const cdkCommand = destroy ? 'destroy' : 'deploy';
      const cdkArgs = [
        cdkCommand,
        stackName,
        '--require-approval', requireApproval ? 'broadening' : 'never'
      ];
      
      if (force) {
        cdkArgs.push('--force');
      }
      
      if (!service.quiet && service.verbose) {
        printInfo(`Running: npx cdk ${cdkArgs.join(' ')}`);
        printInfo(`Stack: ${stackName} (${currentStackType})`);
        printInfo(`Region: ${awsConfig.region}`);
        printInfo(`Account: ${awsConfig.accountId}`);
      }
      
      // Execute CDK command from the project root where cdk/ directory exists
      // The CDK files are in projectRoot/cdk/ after 'semiont init'
      execSync(`npx cdk ${cdkArgs.join(' ')}`, {
        cwd: projectRoot,
        stdio: service.verbose ? 'inherit' : 'pipe',
        env: {
          ...process.env,
          AWS_REGION: awsConfig.region,
          CDK_DEFAULT_ACCOUNT: awsConfig.accountId,
          CDK_DEFAULT_REGION: awsConfig.region,
          SEMIONT_ENV: environment,
          SEMIONT_ROOT: projectRoot
        }
      });
      
      if (!service.quiet) {
        if (destroy) {
          printSuccess(`✅ ${stackName} destroyed`);
        } else {
          printSuccess(`✅ ${stackName} provisioned`);
        }
      }
      
      results.push({
        stackName,
        stackType: currentStackType,
        success: true,
        operation: cdkCommand
      });
      
    } catch (error) {
      allSuccessful = false;
      
      if (!service.quiet) {
        printError(`Failed to ${destroy ? 'destroy' : 'provision'} ${stackName}: ${error}`);
      }
      
      results.push({
        stackName,
        stackType: currentStackType,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Stop on first error unless force is used
      if (!force) {
        break;
      }
    }
  }
  
  return {
    success: allSuccessful,
    dependencies: stackType === 'app' ? ['data'] : [],
    resources: {
      platform: 'aws',
      data: {
        region: awsConfig.region,
        accountId: awsConfig.accountId,
        stacks: results.filter(r => r.success).map(r => r.stackName)
      }
    },
    metadata: {
      serviceType: 'stack',
      operation: destroy ? 'destroy' : 'provision',
      stackType,
      results,
      environment
    }
  };
};

/**
 * Descriptor for AWS stack provision handler
 */
export const stackProvisionDescriptor: HandlerDescriptor<AWSProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'aws',
  serviceType: 'stack',
  handler: provisionStackService,
  requiresDiscovery: false
};