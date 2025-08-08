import * as cdk from 'aws-cdk-lib';
import { CloudFormationClient, CreateStackCommand, UpdateStackCommand, DescribeStacksCommand, StackStatus } from '@aws-sdk/client-cloudformation';
import { createStack } from './stack-factory.js';
import type { SemiontConfiguration } from '@semiont/config';
import * as fs from 'fs';
import * as path from 'path';

export interface DeployOptions {
  requireApproval?: boolean;
  verbose?: boolean;
  force?: boolean;
  context?: Record<string, string>;
}

export class CdkDeployer {
  private cloudFormationClient: CloudFormationClient;
  private region: string;
  private account: string;
  private config: SemiontConfiguration;

  constructor(config: SemiontConfiguration) {
    this.config = config;
    this.region = config.aws.region;
    this.account = config.aws.accountId;
    this.cloudFormationClient = new CloudFormationClient({ region: this.region });
  }

  private log(message: string): void {
    console.log(`[${new Date().toISOString()}] ${message}`);
  }

  /**
   * Synthesize CDK app and return CloudFormation template
   */
  private synthesizeStack(stackTypeName: string, stackName: string, dependencies?: any, context?: Record<string, string>): string {
    const app = new cdk.App({
      outdir: './cdk.out.tmp',
      ...(context && { context })
    });

    createStack(stackTypeName, app, stackName, {
      env: { account: this.account, region: this.region }
    }, dependencies);

    // Synthesize the app
    const cloudAssembly = app.synth();
    
    // Read the generated template
    const templatePath = path.join(cloudAssembly.directory, `${stackName}.template.json`);
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found at ${templatePath}`);
    }

    return fs.readFileSync(templatePath, 'utf8');
  }

  /**
   * Check if stack exists
   */
  private async stackExists(stackName: string): Promise<boolean> {
    try {
      const response = await this.cloudFormationClient.send(
        new DescribeStacksCommand({ StackName: stackName })
      );
      return Boolean(response.Stacks && response.Stacks.length > 0);
    } catch (error: any) {
      if (error.name === 'ValidationError') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Wait for stack operation to complete
   */
  private async waitForStackOperation(stackName: string, operation: 'CREATE' | 'UPDATE'): Promise<boolean> {
    const maxWaitTime = 30 * 60 * 1000; // 30 minutes
    const pollInterval = 10 * 1000; // 10 seconds
    const startTime = Date.now();

    this.log(`⏳ Waiting for ${operation.toLowerCase()} operation to complete...`);

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const response = await this.cloudFormationClient.send(
          new DescribeStacksCommand({ StackName: stackName })
        );

        const stack = response.Stacks?.[0];
        if (!stack) {
          this.log(`❌ Stack ${stackName} not found`);
          return false;
        }

        const status = stack.StackStatus!;
        this.log(`📊 Stack status: ${status}`);

        // Success states
        if (status === StackStatus.CREATE_COMPLETE || status === StackStatus.UPDATE_COMPLETE) {
          this.log(`✅ ${operation.toLowerCase()} completed successfully`);
          return true;
        }

        // Failure states
        if (status.includes('FAILED') || status.includes('ROLLBACK')) {
          this.log(`❌ ${operation.toLowerCase()} failed with status: ${status}`);
          return false;
        }

        // In progress states - continue waiting
        if (status.includes('IN_PROGRESS')) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          continue;
        }

      } catch (error: any) {
        this.log(`❌ Error checking stack status: ${error.message}`);
        return false;
      }
    }

    this.log(`❌ ${operation.toLowerCase()} operation timed out after ${maxWaitTime / 1000 / 60} minutes`);
    return false;
  }

  /**
   * Deploy infrastructure stack programmatically
   */
  async deployInfraStack(options: DeployOptions = {}): Promise<boolean> {
    this.log(`📦 Deploying ${this.config.site.siteName} Infrastructure Stack...`);
    this.log('   Contains: VPC, RDS, EFS, Secrets Manager');

    try {
      // Build context from config
      const context = {
        ...options.context,
        adminEmail: this.config.site.adminEmail,
        databaseName: this.config.aws.database.name
      };
      
      // Synthesize the template
      const infraStackName = (this.config as any).stacks?.infraStack || 'SemiontInfraStack';
      const template = this.synthesizeStack(infraStackName, infraStackName, undefined, context);
      const stackExists = await this.stackExists(infraStackName);

      if (stackExists) {
        this.log('🔄 Updating existing infrastructure stack...');
        await this.cloudFormationClient.send(
          new UpdateStackCommand({
            StackName: 'SemiontInfraStack',
            TemplateBody: template,
            Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM']
          })
        );
        return await this.waitForStackOperation('SemiontInfraStack', 'UPDATE');
      } else {
        this.log('🆕 Creating new infrastructure stack...');
        await this.cloudFormationClient.send(
          new CreateStackCommand({
            StackName: 'SemiontInfraStack',
            TemplateBody: template,
            Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM']
          })
        );
        return await this.waitForStackOperation('SemiontInfraStack', 'CREATE');
      }

    } catch (error: any) {
      this.log(`❌ Failed to deploy infrastructure stack: ${error.message}`);
      return false;
    }
  }

  /**
   * Get infrastructure stack outputs for app stack dependencies
   */
  private async getInfraStackOutputs(): Promise<any> {
    try {
      const response = await this.cloudFormationClient.send(
        new DescribeStacksCommand({ StackName: 'SemiontInfraStack' })
      );

      const stack = response.Stacks?.[0];
      if (!stack) {
        throw new Error('Infrastructure stack not found');
      }

      // For now, we'll create a simplified approach
      // In a full implementation, you'd extract actual outputs and convert them to CDK references
      return {
        vpc: null, // Would need to import from stack outputs
        fileSystem: null,
        database: null,
        dbCredentials: null,
        appSecrets: null,
        jwtSecret: null,
        adminPassword: null,
        googleOAuth: null,
        githubOAuth: null,
        adminEmails: null
      };

    } catch (error: any) {
      this.log(`❌ Failed to get infrastructure stack outputs: ${error.message}`);
      throw error;
    }
  }

  /**
   * Deploy application stack programmatically
   */
  async deployAppStack(options: DeployOptions = {}): Promise<boolean> {
    this.log(`🏗️ Creating ${this.config.site.siteName} Application Stack...`);
    this.log('   Contains: ECS, ALB, WAF, CloudWatch');

    try {
      // Get dependencies from infrastructure stack
      const dependencies = await this.getInfraStackOutputs();
      
      // Build context from config
      const context = {
        ...options.context,
        siteName: this.config.site.siteName,
        domain: this.config.site.domain,
        rootDomain: this.config.aws.rootDomain,
        oauthAllowedDomains: this.config.site.oauthAllowedDomains.join(','),
        databaseName: this.config.aws.database.name,
        certificateArn: this.config.aws.certificateArn,
        hostedZoneId: this.config.aws.hostedZoneId
      };
      
      // Synthesize the template
      const appStackName = (this.config as any).stacks?.appStack || 'SemiontAppStack';
      const template = this.synthesizeStack(appStackName, appStackName, dependencies, context);
      const stackExists = await this.stackExists(appStackName);

      if (stackExists) {
        this.log('🔄 Updating existing application stack...');
        await this.cloudFormationClient.send(
          new UpdateStackCommand({
            StackName: 'SemiontAppStack',
            TemplateBody: template,
            Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM']
          })
        );
        return await this.waitForStackOperation('SemiontAppStack', 'UPDATE');
      } else {
        this.log('🆕 Creating new application stack...');
        await this.cloudFormationClient.send(
          new CreateStackCommand({
            StackName: 'SemiontAppStack',
            TemplateBody: template,
            Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM']
          })
        );
        return await this.waitForStackOperation('SemiontAppStack', 'CREATE');
      }

    } catch (error: any) {
      this.log(`❌ Failed to deploy application stack: ${error.message}`);
      return false;
    }
  }

  /**
   * Clean up temporary CDK output directory
   */
  cleanup(): void {
    const tmpDir = './cdk.out.tmp';
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}