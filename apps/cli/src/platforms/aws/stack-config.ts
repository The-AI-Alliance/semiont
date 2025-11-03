
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { StackOutput, AWSError } from './types.js';
import { validateAwsResourceName, assertValid } from '../../core/validators.js';
import { logger } from '../../core/io/logger.js';
import { loadEnvironmentConfig, findProjectRoot, type EnvironmentConfig } from '@semiont/core';

export interface SemiontConfig {
  region: string;
  dataStack: {
    name: string;
    outputs: Record<string, string>;
  };
  appStack: {
    name: string;
    outputs: Record<string, string>;
  };
}

export class SemiontStackConfig {
  private cfnClient: CloudFormationClient;
  private config: SemiontConfig | null = null;
  private environmentConfig: EnvironmentConfig;
  private environment: string;

  constructor(environment: string) {
    this.environment = environment;
    const projectRoot = findProjectRoot();
    this.environmentConfig = loadEnvironmentConfig(projectRoot, environment);
    
    // AWS is required for stack configuration
    if (!this.environmentConfig.aws) {
      throw new Error(`Environment ${environment} does not have AWS configuration`);
    }
    
    this.cfnClient = new CloudFormationClient({ region: this.environmentConfig.aws.region });
  }

  async getConfig(): Promise<SemiontConfig> {
    if (this.config) {
      return this.config;
    }

    // Get stack names from new schema
    const dataStackName = this.environmentConfig.aws?.stacks?.data || 'SemiontDataStack';
    const appStackName = this.environmentConfig.aws?.stacks?.app || 'SemiontAppStack';

    const validatedDataStackName = assertValid(
      validateAwsResourceName(dataStackName),
      'Data stack name validation'
    );
    const validatedAppStackName = assertValid(
      validateAwsResourceName(appStackName),
      'Application stack name validation'
    );

    try {
      logger.debug('Fetching CloudFormation stack configurations', {
        dataStack: validatedDataStackName,
        appStack: validatedAppStackName
      });

      // Get data stack outputs
      const dataResponse = await this.cfnClient.send(
        new DescribeStacksCommand({ StackName: validatedDataStackName })
      );
      
      if (!dataResponse.Stacks?.[0]) {
        throw new AWSError(`Data stack ${validatedDataStackName} not found`);
      }
      
      const dataOutputs = this.parseOutputs((dataResponse.Stacks[0].Outputs || []).filter(o => o.OutputKey && o.OutputValue) as StackOutput[]);

      // Get application stack outputs
      const appResponse = await this.cfnClient.send(
        new DescribeStacksCommand({ StackName: validatedAppStackName })
      );
      
      if (!appResponse.Stacks?.[0]) {
        throw new AWSError(`Application stack ${validatedAppStackName} not found`);
      }
      
      const appOutputs = this.parseOutputs((appResponse.Stacks[0].Outputs || []).filter(o => o.OutputKey && o.OutputValue) as StackOutput[]);

      this.config = {
        region: this.environmentConfig.aws!.region,
        dataStack: {
          name: validatedDataStackName,
          outputs: dataOutputs,
        },
        appStack: {
          name: validatedAppStackName,
          outputs: appOutputs,
        },
      };

      return this.config!;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to get stack configuration', { error: errorMessage });
      throw new AWSError(`Failed to get stack configuration: ${errorMessage}`);
    }
  }

  private parseOutputs(outputs: StackOutput[]): Record<string, string> {
    const result: Record<string, string> = {};
    outputs.forEach((output) => {
      if (output.OutputKey && output.OutputValue) {
        result[output.OutputKey] = output.OutputValue;
      }
    });
    return result;
  }

  // Convenience getters with error handling
  async getInfraStackName(): Promise<string> {
    const config = await this.getConfig();
    return config.dataStack.name;
  }

  async getAppStackName(): Promise<string> {
    const config = await this.getConfig();
    return config.appStack.name;
  }

  async getClusterName(): Promise<string> {
    const config = await this.getConfig();
    const clusterName = config.appStack.outputs.ClusterName;
    if (!clusterName) {
      throw new AWSError('ClusterName not found in stack outputs');
    }
    return clusterName;
  }

  async getBackendServiceName(): Promise<string> {
    const config = await this.getConfig();
    const serviceName = config.appStack.outputs.BackendServiceName;
    if (!serviceName) {
      throw new AWSError('BackendServiceName not found in stack outputs');
    }
    return serviceName;
  }

  async getFrontendServiceName(): Promise<string> {
    const config = await this.getConfig();
    const serviceName = config.appStack.outputs.FrontendServiceName;
    if (!serviceName) {
      throw new AWSError('FrontendServiceName not found in stack outputs');
    }
    return serviceName;
  }

  async getBackendServiceArn(): Promise<string> {
    const config = await this.getConfig();
    const serviceArn = config.appStack.outputs.BackendServiceArn;
    if (!serviceArn) {
      throw new AWSError('BackendServiceArn not found in stack outputs');
    }
    return serviceArn;
  }

  async getFrontendServiceArn(): Promise<string> {
    const config = await this.getConfig();
    const serviceArn = config.appStack.outputs.FrontendServiceArn;
    if (!serviceArn) {
      throw new AWSError('FrontendServiceArn not found in stack outputs');
    }
    return serviceArn;
  }

  // Service name defaults to backend for simplicity
  async getServiceName(): Promise<string> {
    return this.getBackendServiceName();
  }

  async getServiceArn(): Promise<string> {
    return this.getBackendServiceArn();
  }

  async getLogGroupName(): Promise<string> {
    const config = await this.getConfig();
    const logGroupName = config.appStack.outputs.LogGroupName;
    if (!logGroupName) {
      throw new AWSError('LogGroupName not found in stack outputs');
    }
    return logGroupName;
  }

  async getGoogleOAuthSecretName(): Promise<string> {
    const config = await this.getConfig();
    const secretName = config.dataStack.outputs.GoogleOAuthSecretName;
    if (!secretName) {
      throw new AWSError('GoogleOAuthSecretName not found in stack outputs');
    }
    return secretName;
  }

  async getGitHubOAuthSecretName(): Promise<string> {
    // GitHub OAuth is not currently supported
    throw new AWSError('GitHub OAuth is not supported. Only Google OAuth is available.', { feature: 'UNSUPPORTED_FEATURE' });
  }

  async getAdminEmailsSecretName(): Promise<string> {
    const config = await this.getConfig();
    const secretName = config.dataStack.outputs.AdminEmailsSecretName;
    if (!secretName) {
      throw new AWSError('AdminEmailsSecretName not found in stack outputs');
    }
    return secretName;
  }

  async getAdminPasswordSecretName(): Promise<string> {
    const config = await this.getConfig();
    const secretName = config.dataStack.outputs.AdminPasswordSecretName;
    if (!secretName) {
      throw new AWSError('AdminPasswordSecretName not found in stack outputs');
    }
    return secretName;
  }

  async getWebsiteUrl(): Promise<string> {
    const config = await this.getConfig();
    const url = config.appStack.outputs.CustomDomainUrl;
    if (!url) {
      throw new AWSError('CustomDomainUrl not found in stack outputs');
    }
    return url;
  }

  async getDatabaseEndpoint(): Promise<string> {
    const config = await this.getConfig();
    const endpoint = config.dataStack.outputs.DatabaseEndpoint;
    if (!endpoint) {
      throw new AWSError('DatabaseEndpoint not found in stack outputs');
    }
    return endpoint;
  }

  async getSiteName(): Promise<string> {
    if (!this.environmentConfig.site?.siteName) {
      throw new Error(`Site name not configured for environment ${this.environment}`);
    }
    return this.environmentConfig.site.siteName;
  }

  async getDomainName(): Promise<string> {
    if (!this.environmentConfig.site?.domain) {
      throw new Error(`Domain not configured for environment ${this.environment}`);
    }
    return this.environmentConfig.site.domain;
  }

  async getLoadBalancerDNS(): Promise<string> {
    const config = await this.getConfig();
    const loadBalancerDNS = config.appStack.outputs.LoadBalancerDNS;
    if (!loadBalancerDNS) {
      throw new AWSError('LoadBalancerDNS not found in stack outputs');
    }
    return loadBalancerDNS;
  }

  async getWAFWebACLArn(): Promise<string> {
    const config = await this.getConfig();
    const wafArn = config.appStack.outputs.WAFWebACLArn;
    if (!wafArn) {
      throw new AWSError('WAFWebACLArn not found in stack outputs');
    }
    return wafArn;
  }

  async getEfsFileSystemId(): Promise<string> {
    const config = await this.getConfig();
    const efsId = config.dataStack.outputs.EfsFileSystemId;
    if (!efsId) {
      throw new AWSError('EfsFileSystemId not found in stack outputs');
    }
    return efsId;
  }
}