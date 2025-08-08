
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { StackOutput, AWSError } from './types.js';
import { validateAwsResourceName, assertValid } from './validators.js';
import { logger } from './logger.js';
import { config } from '@semiont/config-loader';

export interface SemiontConfig {
  region: string;
  infraStack: {
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

  constructor(region: string = config.aws.region) {
    this.cfnClient = new CloudFormationClient({ region });
  }

  async getConfig(): Promise<SemiontConfig> {
    if (this.config) {
      return this.config;
    }

    const infraStackName = assertValid(
      validateAwsResourceName('SemiontInfraStack'),
      'Infrastructure stack name validation'
    );
    const appStackName = assertValid(
      validateAwsResourceName('SemiontAppStack'),
      'Application stack name validation'
    );

    try {
      logger.debug('Fetching CloudFormation stack configurations', {
        infraStack: infraStackName,
        appStack: appStackName
      });

      // Get infrastructure stack outputs
      const infraResponse = await this.cfnClient.send(
        new DescribeStacksCommand({ StackName: infraStackName })
      );
      
      if (!infraResponse.Stacks?.[0]) {
        throw new AWSError(`Infrastructure stack ${infraStackName} not found`);
      }
      
      const infraOutputs = this.parseOutputs((infraResponse.Stacks[0].Outputs || []).filter(o => o.OutputKey && o.OutputValue) as StackOutput[]);

      // Get application stack outputs
      const appResponse = await this.cfnClient.send(
        new DescribeStacksCommand({ StackName: appStackName })
      );
      
      if (!appResponse.Stacks?.[0]) {
        throw new AWSError(`Application stack ${appStackName} not found`);
      }
      
      const appOutputs = this.parseOutputs((appResponse.Stacks[0].Outputs || []).filter(o => o.OutputKey && o.OutputValue) as StackOutput[]);

      this.config = {
        region: config.aws.region,
        infraStack: {
          name: infraStackName,
          outputs: infraOutputs,
        },
        appStack: {
          name: appStackName,
          outputs: appOutputs,
        },
      };

      return this.config;
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

  // Legacy method for backward compatibility - defaults to backend
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
    const secretName = config.infraStack.outputs.GoogleOAuthSecretName;
    if (!secretName) {
      throw new AWSError('GoogleOAuthSecretName not found in stack outputs');
    }
    return secretName;
  }

  async getGitHubOAuthSecretName(): Promise<string> {
    // GitHub OAuth is no longer supported, but keeping method for backward compatibility
    throw new AWSError('GitHub OAuth is no longer supported. Only Google OAuth is available.', { feature: 'DEPRECATED_FEATURE' });
  }

  async getAdminEmailsSecretName(): Promise<string> {
    const config = await this.getConfig();
    const secretName = config.infraStack.outputs.AdminEmailsSecretName;
    if (!secretName) {
      throw new AWSError('AdminEmailsSecretName not found in stack outputs');
    }
    return secretName;
  }

  async getAdminPasswordSecretName(): Promise<string> {
    const config = await this.getConfig();
    const secretName = config.infraStack.outputs.AdminPasswordSecretName;
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
    const endpoint = config.infraStack.outputs.DatabaseEndpoint;
    if (!endpoint) {
      throw new AWSError('DatabaseEndpoint not found in stack outputs');
    }
    return endpoint;
  }

  async getSiteName(): Promise<string> {
    return config.site.siteName;
  }

  async getDomainName(): Promise<string> {
    return config.site.domain;
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
    const efsId = config.infraStack.outputs.EfsFileSystemId;
    if (!efsId) {
      throw new AWSError('EfsFileSystemId not found in stack outputs');
    }
    return efsId;
  }
}