import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as neptune from 'aws-cdk-lib/aws-neptune';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class SemiontDataStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly fileSystem: efs.FileSystem;
  public readonly database: rds.DatabaseInstance;
  public readonly neptuneCluster: neptune.CfnDBCluster;
  public readonly neptuneInstance: neptune.CfnDBInstance;
  public readonly dbCredentials: secretsmanager.Secret;
  public readonly appSecrets: secretsmanager.Secret;
  public readonly jwtSecret: secretsmanager.Secret;
  public readonly adminPassword: secretsmanager.Secret;
  public readonly googleOAuth: secretsmanager.Secret;
  public readonly githubOAuth: secretsmanager.Secret;
  public readonly adminEmails: secretsmanager.Secret;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly neptuneSecurityGroup: ec2.SecurityGroup;
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
    const adminEmail = this.node.tryGetContext('adminEmail') || 'admin@example.com';
    this.adminEmails = new secretsmanager.Secret(this, 'AdminEmails', {
      description: 'Comma-separated list of admin email addresses',
      secretObjectValue: {
        emails: cdk.SecretValue.unsafePlainText(adminEmail),
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
      databaseName: this.node.tryGetContext('databaseName') || 'semiont',
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

    // Neptune Graph Database (required for document relationships)
    // Neptune subnet group
    const neptuneSubnetGroup = new neptune.CfnDBSubnetGroup(this, 'NeptuneSubnetGroup', {
      dbSubnetGroupDescription: 'Subnet group for Neptune graph database',
      subnetIds: this.vpc.privateSubnets.map(subnet => subnet.subnetId),
      dbSubnetGroupName: `${this.stackName}-neptune-subnet-group`,
    });

    // Neptune security group
    this.neptuneSecurityGroup = new ec2.SecurityGroup(this, 'NeptuneSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Neptune graph database',
      allowAllOutbound: false,
    });

    // Allow ECS to access Neptune
    this.neptuneSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(8182),
      'Allow ECS to access Neptune'
    );

    // Neptune parameter group for optimal performance
    const neptuneParameterGroup = new neptune.CfnDBParameterGroup(this, 'NeptuneParameterGroup', {
      family: 'neptune1.3',
      parameters: {
        'neptune_enable_audit_log': '0',
        'neptune_query_timeout': '120000',
      },
      description: 'Neptune parameter group for Semiont',
    });

    // Neptune cluster
    this.neptuneCluster = new neptune.CfnDBCluster(this, 'NeptuneCluster', {
      dbSubnetGroupName: neptuneSubnetGroup.dbSubnetGroupName,
      vpcSecurityGroupIds: [this.neptuneSecurityGroup.securityGroupId],
      dbClusterParameterGroupName: neptuneParameterGroup.ref,
      engineVersion: '1.3.0.0',
      storageEncrypted: true,
      backupRetentionPeriod: 7,
      preferredBackupWindow: '03:00-04:00',
      preferredMaintenanceWindow: 'sun:04:00-sun:05:00',
      deletionProtection: true,
      iamDatabaseAuthenticationEnabled: true,
      tags: [
        { key: 'Application', value: 'Semiont' },
        { key: 'Component', value: 'GraphDatabase' },
        { key: 'Environment', value: this.node.tryGetContext('environment') || 'production' },
      ],
    });

    // Neptune instance (t4g.medium is ARM-based and ~7% cheaper than t3.medium)
    this.neptuneInstance = new neptune.CfnDBInstance(this, 'NeptuneInstance', {
      dbInstanceClass: 'db.t4g.medium',
      dbClusterIdentifier: this.neptuneCluster.ref,
      dbSubnetGroupName: neptuneSubnetGroup.dbSubnetGroupName,
    });

    // Outputs for Neptune
    new cdk.CfnOutput(this, 'NeptuneClusterEndpoint', {
      value: this.neptuneCluster.attrEndpoint,
      description: 'Neptune Cluster Endpoint',
      exportName: `${this.stackName}-NeptuneClusterEndpoint`,
    });

    new cdk.CfnOutput(this, 'NeptuneClusterId', {
      value: this.neptuneCluster.attrClusterResourceId,
      description: 'Neptune Cluster ID',
      exportName: `${this.stackName}-NeptuneClusterId`,
    });

    new cdk.CfnOutput(this, 'NeptuneReadEndpoint', {
      value: this.neptuneCluster.attrReadEndpoint,
      description: 'Neptune Read Endpoint',
      exportName: `${this.stackName}-NeptuneReadEndpoint`,
    });

    new cdk.CfnOutput(this, 'NeptunePort', {
      value: this.neptuneCluster.attrPort,
      description: 'Neptune Port',
      exportName: `${this.stackName}-NeptunePort`,
    });

    new cdk.CfnOutput(this, 'NeptuneSecurityGroupId', {
      value: this.neptuneSecurityGroup.securityGroupId,
      description: 'Neptune Security Group ID',
      exportName: `${this.stackName}-NeptuneSecurityGroupId`,
    });

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

    // Export outputs for cross-stack references
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
      exportName: `${this.stackName}-VpcId`,
    });

    // Export subnet IDs for VPC import
    new cdk.CfnOutput(this, 'PublicSubnet1Id', {
      value: this.vpc.publicSubnets[0].subnetId,
      description: 'Public Subnet 1 ID',
      exportName: `${this.stackName}-PublicSubnet1Id`,
    });

    new cdk.CfnOutput(this, 'PublicSubnet2Id', {
      value: this.vpc.publicSubnets[1].subnetId,
      description: 'Public Subnet 2 ID',
      exportName: `${this.stackName}-PublicSubnet2Id`,
    });

    new cdk.CfnOutput(this, 'PrivateSubnet1Id', {
      value: this.vpc.privateSubnets[0].subnetId,
      description: 'Private Subnet 1 ID',
      exportName: `${this.stackName}-PrivateSubnet1Id`,
    });

    new cdk.CfnOutput(this, 'PrivateSubnet2Id', {
      value: this.vpc.privateSubnets[1].subnetId,
      description: 'Private Subnet 2 ID',
      exportName: `${this.stackName}-PrivateSubnet2Id`,
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.instanceEndpoint.hostname,
      description: 'RDS Database Endpoint',
      exportName: `${this.stackName}-DatabaseEndpoint`,
    });

    new cdk.CfnOutput(this, 'DatabasePort', {
      value: this.database.instanceEndpoint.port.toString(),
      description: 'RDS Database Port',
      exportName: `${this.stackName}-DatabasePort`,
    });

    new cdk.CfnOutput(this, 'EfsFileSystemId', {
      value: this.fileSystem.fileSystemId,
      description: 'EFS File System ID',
      exportName: `${this.stackName}-EfsFileSystemId`,
    });

    // Security Group IDs for import
    new cdk.CfnOutput(this, 'DbSecurityGroupId', {
      value: this.dbSecurityGroup.securityGroupId,
      description: 'Database Security Group ID',
      exportName: `${this.stackName}-DbSecurityGroupId`,
    });

    new cdk.CfnOutput(this, 'EcsSecurityGroupId', {
      value: this.ecsSecurityGroup.securityGroupId,
      description: 'ECS Security Group ID',
      exportName: `${this.stackName}-EcsSecurityGroupId`,
    });

    new cdk.CfnOutput(this, 'AlbSecurityGroupId', {
      value: this.albSecurityGroup.securityGroupId,
      description: 'ALB Security Group ID',
      exportName: `${this.stackName}-AlbSecurityGroupId`,
    });

    // Secret ARNs for import
    new cdk.CfnOutput(this, 'DbCredentialsSecretArn', {
      value: this.dbCredentials.secretArn,
      description: 'Database Credentials Secret ARN',
      exportName: `${this.stackName}-DbCredentialsSecretArn`,
    });

    new cdk.CfnOutput(this, 'AppSecretsSecretArn', {
      value: this.appSecrets.secretArn,
      description: 'App Secrets Secret ARN',
      exportName: `${this.stackName}-AppSecretsSecretArn`,
    });

    new cdk.CfnOutput(this, 'JwtSecretArn', {
      value: this.jwtSecret.secretArn,
      description: 'JWT Secret ARN',
      exportName: `${this.stackName}-JwtSecretArn`,
    });

    new cdk.CfnOutput(this, 'GoogleOAuthSecretArn', {
      value: this.googleOAuth.secretArn,
      description: 'Google OAuth Secret ARN',
      exportName: `${this.stackName}-GoogleOAuthSecretArn`,
    });

    new cdk.CfnOutput(this, 'GitHubOAuthSecretArn', {
      value: this.githubOAuth.secretArn,
      description: 'GitHub OAuth Secret ARN',
      exportName: `${this.stackName}-GitHubOAuthSecretArn`,
    });

    new cdk.CfnOutput(this, 'AdminEmailsSecretArn', {
      value: this.adminEmails.secretArn,
      description: 'Admin Emails Secret ARN',
      exportName: `${this.stackName}-AdminEmailsSecretArn`,
    });

    new cdk.CfnOutput(this, 'AdminPasswordSecretArn', {
      value: this.adminPassword.secretArn,
      description: 'Admin Password Secret ARN',
      exportName: `${this.stackName}-AdminPasswordSecretArn`,
    });
  }
}