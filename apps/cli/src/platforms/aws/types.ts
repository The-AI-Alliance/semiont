
import { ScriptError } from '@semiont/core';

// AWS CloudFormation Stack Output types
export interface StackOutput {
  OutputKey?: string;
  OutputValue?: string;
  Description?: string;
  ExportName?: string;
}

export interface StackOutputs {
  [key: string]: string;
}

// Configuration types
export interface DataStackConfig {
  outputs: {
    GoogleOAuthSecretName: string;
    AppSecretsName: string;
    AdminEmailsSecretName: string;
    AdminPasswordSecretName: string;
    DatabaseEndpoint: string;
    DatabaseName: string;
    DatabasePort: string;
    EfsFileSystemId: string;
    VPCId: string;
    PrivateSubnetIds: string;
    PublicSubnetIds: string;
  };
}

export interface AppStackConfig {
  outputs: {
    ClusterName: string;
    BackendServiceName: string;
    FrontendServiceName: string;
    BackendServiceArn: string;
    FrontendServiceArn: string;
    LogGroupName: string;
    CustomDomainUrl: string;
    LoadBalancerArn: string;
    LoadBalancerDNS: string;
    WAFWebACLArn: string;
  };
}

export interface StackConfiguration {
  dataStack: DataStackConfig;
  appStack: AppStackConfig;
}

// ECS Task and Service types
export interface ECSTask {
  id: string;
  service: string;
  status: string;
  health: string;
  created: Date;
  lastStatus: string;
}

export class AWSError extends ScriptError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'AWS_ERROR', details);
    this.name = 'AWSError';
  }
}

/**
 * AWS platform resources - for services running on AWS infrastructure
 */
export interface AWSResources {
  // Core identifiers
  arn?: string;
  id?: string;                // Generic resource ID
  name?: string;              // Resource name
  stackName?: string;         // CloudFormation stack name
  stackType?: string;         // Stack type (data, app)
  
  // Service-specific
  taskArn?: string;          // ECS
  taskDefinitionArn?: string;
  clusterId?: string;         // ECS cluster ID
  clusterArn?: string;
  serviceArn?: string;
  instanceId?: string;        // EC2
  functionArn?: string;       // Lambda
  bucketName?: string;        // S3
  distributionId?: string;    // CloudFront
  databaseId?: string;        // RDS
  volumeId?: string;          // EBS/EFS volume ID
  networkId?: string;         // VPC/subnet ID
  albArn?: string;            // Application Load Balancer
  endpoint?: string;          // Connection endpoint (RDS, ECS ALB, Lambda URL, etc.)
  
  // Stack-related
  stacks?: string[];          // List of stack names (for stack provision)
  
  // Common metadata
  region: string;
  accountId?: string;
  consoleUrl?: string;
  tags?: Record<string, string>;
}
