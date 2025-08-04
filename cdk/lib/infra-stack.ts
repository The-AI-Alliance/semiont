import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { config } from '../../config';

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
        excludeCharacters: '"@/\\',
      },
    });

    // Application secrets (contains both session and NextAuth secrets)
    this.appSecrets = new secretsmanager.Secret(this, 'AppSecrets', {
      description: 'Application secrets for Semiont (session and NextAuth)',
      secretObjectValue: {
        sessionSecret: cdk.SecretValue.unsafePlainText('REPLACE_WITH_SESSION_SECRET_64_CHARS'),
        nextAuthSecret: cdk.SecretValue.unsafePlainText('REPLACE_WITH_NEXTAUTH_SECRET_64_CHARS'),
      },
    });

    this.jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'jwtSecret',
        passwordLength: 64,
      },
    });

    // Admin password in Secrets Manager  
    this.adminPassword = new secretsmanager.Secret(this, 'AdminPassword', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'password',
        passwordLength: 20,
        excludeCharacters: '"@/\\`\'',
      },
    });

    // OAuth credentials for Google
    this.googleOAuth = new secretsmanager.Secret(this, 'GoogleOAuthCredentials', {
      description: 'Google OAuth client credentials for Semiont',
      secretObjectValue: {
        clientId: cdk.SecretValue.unsafePlainText('REPLACE_WITH_GOOGLE_CLIENT_ID'),
        clientSecret: cdk.SecretValue.unsafePlainText('REPLACE_WITH_GOOGLE_CLIENT_SECRET'),
      },
    });

    // OAuth credentials for GitHub (temporary - to maintain CloudFormation exports)
    this.githubOAuth = new secretsmanager.Secret(this, 'GitHubOAuthCredentials', {
      description: 'GitHub OAuth app credentials for Semiont (unused)',
      secretObjectValue: {
        clientId: cdk.SecretValue.unsafePlainText('UNUSED'),
        clientSecret: cdk.SecretValue.unsafePlainText('UNUSED'),
      },
    });

    // Admin users list
    this.adminEmails = new secretsmanager.Secret(this, 'AdminEmails', {
      description: 'Comma-separated list of admin email addresses',
      secretObjectValue: {
        emails: cdk.SecretValue.unsafePlainText(config.site.adminEmail),
      },
    });

    // Security Groups
    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Semiont database',
      allowAllOutbound: false, // Database should not initiate outbound connections
    });

    this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Semiont ECS tasks',
      // allowAllOutbound: true (default) - needed for internet access, docker pulls, etc.
    });

    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Application Load Balancer',
    });

    // Configure security group rules
    this.dbSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow ECS to access PostgreSQL'
    );

    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP'
    );
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS'
    );

    this.ecsSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(80),
      'Allow ALB to reach ECS'
    );

    // PostgreSQL RDS with encryption
    this.database = new rds.DatabaseInstance(this, 'SemiontDatabase', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      credentials: rds.Credentials.fromSecret(this.dbCredentials),
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [this.dbSecurityGroup],
      databaseName: config.aws.database.name,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      multiAz: false,
      allowMajorVersionUpgrade: false,
      autoMinorVersionUpgrade: true,
      deleteAutomatedBackups: false,
    });

    // EFS for persistent file storage
    this.fileSystem = new efs.FileSystem(this, 'SemiontEFS', {
      vpc: this.vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Allow ECS to access EFS
    this.fileSystem.connections.allowDefaultPortFrom(this.ecsSecurityGroup, 'Allow ECS to EFS');

    // Add explicit EFS filesystem policy to allow access
    this.fileSystem.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowClientAccess',
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
        actions: [
          'elasticfilesystem:ClientMount',
          'elasticfilesystem:ClientWrite',
          'elasticfilesystem:ClientRootAccess',
        ],
        resources: ['*'],
        conditions: {
          Bool: {
            'aws:SecureTransport': 'false', // Allow non-TLS connections
          },
        },
      })
    );

    // Outputs for reference (not exported since we're passing objects directly)
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.instanceEndpoint.hostname,
      description: 'RDS Database Endpoint',
    });

    new cdk.CfnOutput(this, 'EfsFileSystemId', {
      value: this.fileSystem.fileSystemId,
      description: 'EFS File System ID',
    });

    // Secret outputs for scripts
    new cdk.CfnOutput(this, 'GoogleOAuthSecretName', {
      value: this.googleOAuth.secretName,
      description: 'Google OAuth Secret Name',
    });

    new cdk.CfnOutput(this, 'GitHubOAuthSecretName', {
      value: this.githubOAuth.secretName,
      description: 'GitHub OAuth Secret Name (unused)',
    });

    new cdk.CfnOutput(this, 'AdminEmailsSecretName', {
      value: this.adminEmails.secretName,
      description: 'Admin Emails Secret Name',
    });

    new cdk.CfnOutput(this, 'AdminPasswordSecretName', {
      value: this.adminPassword.secretName,
      description: 'Admin Password Secret Name',
    });
  }
}