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
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // In dist/commands/init.mjs, templates is at dist/templates
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
// CDK TEMPLATE GENERATORS
// =====================================================================

/**
 * Generate starter CDK infrastructure stack template
 */
function getCDKInfraStackTemplate(): string {
  return `import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class SemiontInfraStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly fileSystem: efs.FileSystem;
  public readonly database: rds.DatabaseInstance;
  public readonly dbCredentials: secretsmanager.Secret;
  public readonly appSecrets: secretsmanager.Secret;
  public readonly jwtSecret: secretsmanager.Secret;
  public readonly adminPassword: secretsmanager.Secret;
  public readonly googleOAuth: secretsmanager.Secret;
  public readonly githubOAuth: secretsmanager.Secret;
  public readonly adminEmails: secretsmanager.Secret;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly ecsSecurityGroup: ec2.SecurityGroup;
  public readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with proper subnet isolation
    this.vpc = new ec2.Vpc(this, 'SemiontVpc', {
      maxAzs: 2,
      natGateways: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // Database credentials in Secrets Manager
    this.dbCredentials = new secretsmanager.Secret(this, 'DatabaseCredentials', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'semiont' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\\\',
      },
    });

    // Application secrets
    this.appSecrets = new secretsmanager.Secret(this, 'AppSecrets', {
      description: 'Application secrets for Semiont',
      secretObjectValue: {
        sessionSecret: cdk.SecretValue.unsafePlainText('REPLACE_WITH_SESSION_SECRET'),
        nextAuthSecret: cdk.SecretValue.unsafePlainText('REPLACE_WITH_NEXTAUTH_SECRET'),
      },
    });

    this.jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'jwtSecret',
        passwordLength: 64,
      },
    });

    // Admin password
    this.adminPassword = new secretsmanager.Secret(this, 'AdminPassword', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'password',
        passwordLength: 20,
        excludeCharacters: '"@/\\\\\\\\',
      },
    });

    // OAuth credentials (placeholder values)
    this.googleOAuth = new secretsmanager.Secret(this, 'GoogleOAuthCredentials', {
      description: 'Google OAuth client credentials',
      secretObjectValue: {
        clientId: cdk.SecretValue.unsafePlainText('REPLACE_WITH_GOOGLE_CLIENT_ID'),
        clientSecret: cdk.SecretValue.unsafePlainText('REPLACE_WITH_GOOGLE_CLIENT_SECRET'),
      },
    });

    this.githubOAuth = new secretsmanager.Secret(this, 'GitHubOAuthCredentials', {
      description: 'GitHub OAuth app credentials',
      secretObjectValue: {
        clientId: cdk.SecretValue.unsafePlainText('REPLACE_WITH_GITHUB_CLIENT_ID'),
        clientSecret: cdk.SecretValue.unsafePlainText('REPLACE_WITH_GITHUB_CLIENT_SECRET'),
      },
    });

    // Admin emails
    this.adminEmails = new secretsmanager.Secret(this, 'AdminEmails', {
      description: 'Admin email addresses',
      secretObjectValue: {
        emails: cdk.SecretValue.unsafePlainText('admin@example.com'),
      },
    });

    // Security Groups
    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for RDS database',
      allowAllOutbound: false,
    });

    this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for ECS containers',
      allowAllOutbound: true,
    });

    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Application Load Balancer',
      allowAllOutbound: true,
    });

    // Allow ECS to connect to database
    this.dbSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow database access from ECS containers'
    );

    // Allow ALB to connect to ECS
    this.ecsSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(3000),
      'Allow frontend access from ALB'
    );
    
    this.ecsSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(3001),
      'Allow backend access from ALB'
    );

    // Allow public HTTP/HTTPS to ALB
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP from internet'
    );
    
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from internet'
    );

    // EFS File System
    this.fileSystem = new efs.FileSystem(this, 'SemiontFileSystem', {
      vpc: this.vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encrypted: true,
    });

    // Allow ECS to access EFS
    this.fileSystem.connections.allowDefaultPortFrom(this.ecsSecurityGroup);

    // RDS PostgreSQL Database
    this.database = new rds.DatabaseInstance(this, 'SemiontDatabase', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15_4,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [this.dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(this.dbCredentials),
      databaseName: 'semiont',
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      backupRetention: cdk.Duration.days(7),
      deleteAutomatedBackups: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      deletionProtection: false,
    });

    // Output important values
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      exportName: \`\${this.stackName}-VpcId\`,
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.dbInstanceEndpointAddress,
      exportName: \`\${this.stackName}-DatabaseEndpoint\`,
    });

    new cdk.CfnOutput(this, 'FileSystemId', {
      value: this.fileSystem.fileSystemId,
      exportName: \`\${this.stackName}-FileSystemId\`,
    });
  }
}
`;
}

/**
 * Generate CDK app.ts entry point
 */
function getCDKAppTemplate(): string {
  return `#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SemiontInfraStack } from './infra-stack';
import { SemiontAppStack } from './app-stack';

const app = new cdk.App();

// Get configuration from context and environment
const stackType = app.node.tryGetContext('stack-type') || 'all';
const environment = app.node.tryGetContext('environment') || process.env.SEMIONT_ENV || 'production';

// AWS environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1'
};

// Stack props
const stackProps = {
  env,
  synthesizer: new cdk.DefaultStackSynthesizer({
    qualifier: 'hnb659fds' // Default CDK bootstrap qualifier
  })
};

// Create stacks based on stack-type context
let infraStack: SemiontInfraStack | undefined;
let appStack: SemiontAppStack | undefined;

if (stackType === 'infra' || stackType === 'all') {
  console.log('Creating infrastructure stack...');
  infraStack = new SemiontInfraStack(app, 'SemiontInfraStack', stackProps);
}

if ((stackType === 'app' || stackType === 'all') && infraStack) {
  console.log('Creating application stack...');
  appStack = new SemiontAppStack(app, 'SemiontAppStack', {
    ...stackProps,
    vpc: infraStack.vpc,
    fileSystem: infraStack.fileSystem,
    database: infraStack.database,
    dbCredentials: infraStack.dbCredentials,
    appSecrets: infraStack.appSecrets,
    jwtSecret: infraStack.jwtSecret,
    adminPassword: infraStack.adminPassword,
    googleOAuth: infraStack.googleOAuth,
    githubOAuth: infraStack.githubOAuth,
  });
  
  // Add explicit dependency
  appStack.addDependency(infraStack);
} else if (stackType === 'app' && !infraStack) {
  console.error('Error: Cannot create app stack without infra stack.');
  console.error('Run with stack-type=all or deploy infra stack first.');
  process.exit(1);
}

app.synth();
`;
}

/**
 * Generate starter CDK application stack template
 */
function getCDKAppStackTemplate(): string {
  return `import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';

interface SemiontAppStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  fileSystem: efs.FileSystem;
  database: rds.DatabaseInstance;
  dbCredentials: secretsmanager.Secret;
  appSecrets: secretsmanager.Secret;
  jwtSecret: secretsmanager.Secret;
  adminPassword: secretsmanager.Secret;
  googleOAuth: secretsmanager.Secret;
  githubOAuth: secretsmanager.Secret;
  adminEmails: secretsmanager.Secret;
  ecsSecurityGroup: ec2.SecurityGroup;
  albSecurityGroup: ec2.SecurityGroup;
  domainName?: string;
  certificateArn?: string;
  hostedZoneId?: string;
}

export class SemiontAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SemiontAppStackProps) {
    super(scope, id, props);

    const { 
      vpc, 
      fileSystem, 
      database, 
      dbCredentials,
      appSecrets,
      jwtSecret,
      adminPassword,
      googleOAuth,
      githubOAuth,
      adminEmails,
      ecsSecurityGroup,
      albSecurityGroup
    } = props;

    // Configuration
    const siteName = 'Semiont';
    const domainName = 'example.com';
    const oauthAllowedDomains = ['example.com'];
    const databaseName = 'semiont';

    // Certificate ARN parameter (replace with your actual certificate)
    const certificateArn = new cdk.CfnParameter(this, 'CertificateArn', {
      type: 'String', 
      default: 'arn:aws:acm:REGION:ACCOUNT:certificate/CERTIFICATE_ID',
      description: 'ACM Certificate ARN for HTTPS'
    });

    // Hosted Zone ID parameter (replace with your actual zone)
    const hostedZoneId = new cdk.CfnParameter(this, 'HostedZoneId', {
      type: 'String',
      default: 'Z1234567890ABC',
      description: 'Route53 Hosted Zone ID'
    });

    // ECS Cluster with Service Connect
    const cluster = new ecs.Cluster(this, 'SemiontCluster', {
      vpc,
      defaultCloudMapNamespace: {
        name: 'semiont.local',
        type: ecs.NamespaceType.DNS_PRIVATE,
      },
    });

    cluster.enableFargateCapacityProviders();

    // CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, 'SemiontLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Backend Task Definition
    const backendTaskDefinition = new ecs.FargateTaskDefinition(this, 'SemiontBackendTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });
    
    // Frontend Task Definition
    const frontendTaskDefinition = new ecs.FargateTaskDefinition(this, 'SemiontFrontendTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // Add EFS volume to backend
    const efsVolumeConfig: ecs.EfsVolumeConfiguration = {
      fileSystemId: fileSystem.fileSystemId,
      transitEncryption: 'DISABLED',
      authorizationConfig: {
        iam: 'DISABLED',
      },
    };

    backendTaskDefinition.addVolume({
      name: 'efs-volume',
      efsVolumeConfiguration: efsVolumeConfig,
    });

    // IAM permissions for backend
    backendTaskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          dbCredentials.secretArn,
          appSecrets.secretArn,
          jwtSecret.secretArn,
          adminPassword.secretArn,
          googleOAuth.secretArn,
          adminEmails.secretArn,
        ],
      })
    );
    
    // IAM permissions for frontend
    frontendTaskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          appSecrets.secretArn,
          googleOAuth.secretArn,
        ],
      })
    );

    // ECR Repositories
    const backendRepo = ecr.Repository.fromRepositoryName(
      this, 
      'BackendRepo', 
      'semiont-backend'
    );
    
    const frontendRepo = ecr.Repository.fromRepositoryName(
      this, 
      'FrontendRepo', 
      'semiont-frontend'
    );

    // Backend Container
    const backendContainer = backendTaskDefinition.addContainer('backend', {
      image: ecs.ContainerImage.fromEcrRepository(backendRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'backend',
        logGroup,
      }),
      environment: {
        NODE_ENV: 'production',
        PORT: '3001',
        DATABASE_NAME: databaseName,
        SITE_NAME: siteName,
        SITE_DOMAIN: domainName,
        OAUTH_ALLOWED_DOMAINS: oauthAllowedDomains.join(','),
      },
      secrets: {
        DATABASE_HOST: ecs.Secret.fromSecretsManager(dbCredentials, 'host'),
        DATABASE_USER: ecs.Secret.fromSecretsManager(dbCredentials, 'username'),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(dbCredentials, 'password'),
        JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret, 'jwtSecret'),
        SESSION_SECRET: ecs.Secret.fromSecretsManager(appSecrets, 'sessionSecret'),
        ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminPassword, 'password'),
        GOOGLE_CLIENT_ID: ecs.Secret.fromSecretsManager(googleOAuth, 'clientId'),
        GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(googleOAuth, 'clientSecret'),
        ADMIN_EMAILS: ecs.Secret.fromSecretsManager(adminEmails, 'emails'),
      },
      portMappings: [
        {
          containerPort: 3001,
          protocol: ecs.Protocol.TCP,
          name: 'backend',
        },
      ],
    });

    backendContainer.addMountPoints({
      sourceVolume: 'efs-volume',
      containerPath: '/app/uploads',
      readOnly: false,
    });

    // Frontend Container
    const frontendContainer = frontendTaskDefinition.addContainer('frontend', {
      image: ecs.ContainerImage.fromEcrRepository(frontendRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'frontend',
        logGroup,
      }),
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        NEXT_PUBLIC_API_URL: \`https://\${domainName}/api\`,
        BACKEND_INTERNAL_URL: 'http://backend:4000',
        NEXTAUTH_URL: \`https://\${domainName}\`,
        SITE_NAME: siteName,
        SITE_DOMAIN: domainName,
        OAUTH_ALLOWED_DOMAINS: oauthAllowedDomains.join(','),
      },
      secrets: {
        NEXTAUTH_SECRET: ecs.Secret.fromSecretsManager(appSecrets, 'nextAuthSecret'),
        GOOGLE_CLIENT_ID: ecs.Secret.fromSecretsManager(googleOAuth, 'clientId'),
        GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(googleOAuth, 'clientSecret'),
      },
      portMappings: [
        {
          containerPort: 3000,
          protocol: ecs.Protocol.TCP,
          name: 'frontend',
        },
      ],
    });

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'SemiontALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
    });

    // Backend Service with Service Connect
    const backendService = new ecs.FargateService(this, 'SemiontBackendService', {
      cluster,
      taskDefinition: backendTaskDefinition,
      desiredCount: 1,
      securityGroups: [ecsSecurityGroup],
      serviceConnectConfiguration: {
        services: [
          {
            portMappingName: 'backend',
            dnsName: 'backend',
            port: 4000,
          },
        ],
      },
    });

    // Frontend Service with Service Connect
    const frontendService = new ecs.FargateService(this, 'SemiontFrontendService', {
      cluster,
      taskDefinition: frontendTaskDefinition,
      desiredCount: 1,
      securityGroups: [ecsSecurityGroup],
      serviceConnectConfiguration: {
        services: [
          {
            portMappingName: 'frontend',
            dnsName: 'frontend',
            port: 3000,
          },
        ],
      },
    });

    // Target Groups
    const backendTargetGroup = new elbv2.ApplicationTargetGroup(this, 'BackendTargetGroup', {
      vpc,
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
      },
    });

    const frontendTargetGroup = new elbv2.ApplicationTargetGroup(this, 'FrontendTargetGroup', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
      },
    });

    backendService.attachToApplicationTargetGroup(backendTargetGroup);
    frontendService.attachToApplicationTargetGroup(frontendTargetGroup);

    // HTTP Listener (redirects to HTTPS)
    alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        port: '443',
        protocol: elbv2.ApplicationProtocol.HTTPS,
        permanent: true,
      }),
    });

    // HTTPS Listener
    const httpsListener = alb.addListener('HttpsListener', {
      port: 443,
      certificates: [{
        certificateArn: certificateArn.valueAsString,
      }],
      defaultTargetGroups: [frontendTargetGroup],
    });

    // Add backend routing rule
    httpsListener.addTargetGroups('BackendRoute', {
      targetGroups: [backendTargetGroup],
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/*']),
      ],
      priority: 10,
    });

    // Output ALB DNS
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: alb.loadBalancerDnsName,
      description: 'Application Load Balancer DNS name',
    });

    new cdk.CfnOutput(this, 'LoadBalancerURL', {
      value: \`https://\${alb.loadBalancerDnsName}\`,
      description: 'Application URL',
    });
  }
}
`;
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