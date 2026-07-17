import * as cdk from 'aws-cdk-lib';
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
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';

interface SemiontAppStackProps extends cdk.StackProps {
  // No longer passing infra resources as props
  // They will be imported via CloudFormation exports
}

// Topology (see docs/system/CONTAINER-TOPOLOGY.md and apps/frontend/docs/CONTAINER.md):
// the frontend is a config-less static file server for the prebuilt Vite SPA, and the
// user's browser connects directly to the backend origin — auth, admin, and content over
// HTTP routes; domain traffic over the event bus (POST /bus/emit, GET /bus/subscribe SSE).
// The two services never talk to each other, so each gets its own browser-reachable
// HTTPS hostname on a shared ALB: `domain` serves the SPA, `api.<domain>` serves the
// backend. No path-based API routing exists between them.
export class SemiontAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SemiontAppStackProps) {
    super(scope, id, props);

    // Import resources from data stack using CloudFormation exports
    const dataStackName = 'SemiontDataStack';

    // Import VPC - we need to use fromVpcAttributes since fromLookup doesn't work with tokens
    // We're using 2 AZs, so explicitly specify them
    // Note: CDK will show warnings about missing routeTableIds. These warnings can be ignored
    // as we're importing an existing VPC and not modifying routes. The warnings are due to
    // CDK's limitation when importing VPCs via CloudFormation exports.
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: cdk.Fn.importValue(`${dataStackName}-VpcId`),
      availabilityZones: ['us-east-2a', 'us-east-2b'],  // First 2 AZs in us-east-2
      publicSubnetIds: [
        cdk.Fn.importValue(`${dataStackName}-PublicSubnet1Id`),
        cdk.Fn.importValue(`${dataStackName}-PublicSubnet2Id`),
      ],
      privateSubnetIds: [
        cdk.Fn.importValue(`${dataStackName}-PrivateSubnet1Id`),
        cdk.Fn.importValue(`${dataStackName}-PrivateSubnet2Id`),
      ],
    });

    // Import Security Groups
    const dbSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ImportedDbSecurityGroup',
      cdk.Fn.importValue(`${dataStackName}-DbSecurityGroupId`)
    );

    const ecsSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ImportedEcsSecurityGroup',
      cdk.Fn.importValue(`${dataStackName}-EcsSecurityGroupId`)
    );

    const albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ImportedAlbSecurityGroup',
      cdk.Fn.importValue(`${dataStackName}-AlbSecurityGroupId`)
    );

    // Import EFS FileSystem
    const fileSystem = efs.FileSystem.fromFileSystemAttributes(this, 'ImportedFileSystem', {
      fileSystemId: cdk.Fn.importValue(`${dataStackName}-EfsFileSystemId`),
      securityGroup: ecsSecurityGroup,
    });

    // Import Database (for endpoint reference)
    const databaseEndpoint = cdk.Fn.importValue(`${dataStackName}-DatabaseEndpoint`);
    const databasePort = cdk.Fn.importValue(`${dataStackName}-DatabasePort`);

    // Import Secrets
    const dbCredentials = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedDbCredentials',
      cdk.Fn.importValue(`${dataStackName}-DbCredentialsSecretArn`)
    );

    const jwtSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedJwtSecret',
      cdk.Fn.importValue(`${dataStackName}-JwtSecretArn`)
    );

    const adminPassword = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedAdminPassword',
      cdk.Fn.importValue(`${dataStackName}-AdminPasswordSecretArn`)
    );

    const googleOAuth = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedGoogleOAuth',
      cdk.Fn.importValue(`${dataStackName}-GoogleOAuthSecretArn`)
    );

    const adminEmails = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedAdminEmails',
      cdk.Fn.importValue(`${dataStackName}-AdminEmailsSecretArn`)
    );

    // Get configuration from CDK context
    const siteName = this.node.tryGetContext('siteName') || 'Semiont';
    const domainName = this.node.tryGetContext('domain') || 'example.com';
    const rootDomain = this.node.tryGetContext('rootDomain') || 'example.com';
    const oauthAllowedDomains = this.node.tryGetContext('oauthAllowedDomains') || ['example.com'];
    const databaseName = this.node.tryGetContext('databaseName') || 'semiont';
    const awsCertificateArn = this.node.tryGetContext('certificateArn');
    const awsHostedZoneId = this.node.tryGetContext('hostedZoneId');

    // The backend's browser-reachable origin. Users add this host in the SPA's
    // connection panel; every API and bus call goes to it directly from the browser.
    const apiDomainName = `api.${domainName}`;

    const certificateArn = new cdk.CfnParameter(this, 'CertificateArn', {
      type: 'String',
      default: awsCertificateArn,
      description: `ACM Certificate ARN for HTTPS (must cover both ${domainName} and ${apiDomainName})`
    });

    const hostedZoneId = new cdk.CfnParameter(this, 'HostedZoneId', {
      type: 'String',
      default: awsHostedZoneId,
      description: 'Route53 Hosted Zone ID'
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'SemiontCluster', {
      vpc,
    });

    // Enable Container Insights
    cluster.enableFargateCapacityProviders();

    // CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, 'SemiontLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Backend Task Definition
    // Note: CDK may show warnings about deprecated inferenceAccelerators property.
    // This is a known CDK bug (https://github.com/aws/aws-cdk/issues/11339) where CDK internally
    // uses a deprecated CloudFormation property. The warning can be safely ignored.
    const backendTaskDefinition = new ecs.FargateTaskDefinition(this, 'SemiontBackendTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // Frontend Task Definition
    const frontendTaskDefinition = new ecs.FargateTaskDefinition(this, 'SemiontFrontendTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // EFS volume for the backend's knowledge-base storage (git repo + working tree),
    // mounted at /kb — the backend image's working directory.
    const efsVolumeConfig: ecs.EfsVolumeConfiguration = {
      fileSystemId: fileSystem.fileSystemId,
      transitEncryption: 'DISABLED',
      authorizationConfig: {
        iam: 'DISABLED',
      },
    };

    backendTaskDefinition.addVolume({
      name: 'kb-storage',
      efsVolumeConfiguration: efsVolumeConfig,
    });

    // IAM role for backend tasks to access Secrets Manager
    backendTaskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:GetSecretValue',
        ],
        resources: [
          dbCredentials.secretArn,
          jwtSecret.secretArn,
          adminPassword.secretArn,
          googleOAuth.secretArn,
          adminEmails.secretArn,
        ],
      })
    );

    // Add EFS permissions to backend task role
    backendTaskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticfilesystem:ClientMount',
          'elasticfilesystem:ClientWrite',
          'elasticfilesystem:ClientRootAccess',
        ],
        resources: [fileSystem.fileSystemArn],
      })
    );

    // Add ECS Exec permissions to backend task role
    backendTaskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
        ],
        resources: ['*'],
      })
    );

    // Add Neptune permissions for graph database access
    backendTaskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'neptune-db:*',
          'rds:DescribeDBClusters',
          'rds:DescribeDBInstances',
        ],
        resources: ['*'],
      })
    );

    // Add ECS Exec permissions to frontend task role
    frontendTaskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
        ],
        resources: ['*'],
      })
    );

    // Get environment from context
    const environment = this.node.tryGetContext('environment') || 'production';

    // Backend container - use ECR image or default
    const backendImageUri = this.node.tryGetContext('backendImageUri');
    const backendRepoName = `semiont-backend`;
    const backendImage = backendImageUri
      ? ecs.ContainerImage.fromEcrRepository(
          ecr.Repository.fromRepositoryName(this, 'BackendEcrRepo', backendRepoName),
          backendImageUri.split(':')[1] || 'latest'
        )
      : ecs.ContainerImage.fromEcrRepository(
          ecr.Repository.fromRepositoryName(this, 'BackendEcrRepoDefault', backendRepoName),
          'latest'
        );

    const backendContainer = backendTaskDefinition.addContainer('semiont-backend', {
      image: backendImage,
      environment: {
        NODE_ENV: this.node.tryGetContext('nodeEnv') || 'production',
        DEPLOYMENT_VERSION: new Date().toISOString(), // Forces new task definition on every deploy
        DB_HOST: databaseEndpoint,
        DB_PORT: databasePort,
        DB_NAME: databaseName,
        OAUTH_ALLOWED_DOMAINS: Array.isArray(oauthAllowedDomains) ? oauthAllowedDomains.join(',') : oauthAllowedDomains,
        AWS_REGION: this.region, // For AWS SDK clients (S3 storage, Neptune graph)
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(dbCredentials, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbCredentials, 'password'),
        JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret, 'jwtSecret'),
        GOOGLE_CLIENT_ID: ecs.Secret.fromSecretsManager(googleOAuth, 'clientId'),
        GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(googleOAuth, 'clientSecret'),
        // The image bootstraps an admin user at startup when both are set.
        // ADMIN_EMAIL expects a single address (the data stack seeds 'emails'
        // from the site's adminEmail).
        ADMIN_EMAIL: ecs.Secret.fromSecretsManager(adminEmails, 'emails'),
        ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminPassword, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'semiont-backend',
        logGroup,
      }),
      // node-based probe: the alpine images ship no curl (mirrors the image's own HEALTHCHECK)
      healthCheck: {
        command: ['CMD-SHELL', `node -e "require('http').get('http://localhost:4000/api/health', r => process.exit(r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.minutes(1),
      },
    });

    backendContainer.addPortMappings({
      containerPort: 4000,
    });

    // Mount EFS volume for persistent knowledge-base storage
    backendContainer.addMountPoints({
      sourceVolume: 'kb-storage',
      containerPath: '/kb',
      readOnly: false,
    });

    // Frontend container - use ECR image or default
    const frontendImageUri = this.node.tryGetContext('frontendImageUri');
    const frontendRepoName = `semiont-frontend`;
    const frontendImage = frontendImageUri
      ? ecs.ContainerImage.fromEcrRepository(
          ecr.Repository.fromRepositoryName(this, 'FrontendEcrRepo', frontendRepoName),
          frontendImageUri.split(':')[1] || 'latest'
        )
      : ecs.ContainerImage.fromEcrRepository(
          ecr.Repository.fromRepositoryName(this, 'FrontendEcrRepoDefault', frontendRepoName),
          'latest'
        );

    // The frontend image is a static file server for the prebuilt SPA. It takes no
    // configuration (the only variable it reads is PORT, defaulting to 3000) and no
    // secrets — users pick their knowledge bases in the app, and tokens live in the
    // browser's localStorage.
    const frontendContainer = frontendTaskDefinition.addContainer('semiont-frontend', {
      image: frontendImage,
      environment: {
        DEPLOYMENT_VERSION: new Date().toISOString(), // Forces new task definition on every deploy
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'semiont-frontend',
        logGroup,
      }),
      // node-based probe: the alpine images ship no curl (mirrors the image's own HEALTHCHECK)
      healthCheck: {
        command: ['CMD-SHELL', `node -e "require('http').get('http://localhost:3000/', r => process.exit(r.statusCode < 400 ? 0 : 1)).on('error', () => process.exit(1))"`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.minutes(1),
      },
    });

    frontendContainer.addPortMappings({
      containerPort: 3000,
    });

    // Backend ECS Service
    const backendService = new ecs.FargateService(this, 'SemiontBackendService', {
      cluster,
      taskDefinition: backendTaskDefinition,
      desiredCount: 1,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [ecsSecurityGroup],
      assignPublicIp: false,
      healthCheckGracePeriod: cdk.Duration.minutes(2),
      enableExecuteCommand: true,
      circuitBreaker: {
        rollback: true,
      },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // Frontend ECS Service
    const frontendService = new ecs.FargateService(this, 'SemiontFrontendService', {
      cluster,
      taskDefinition: frontendTaskDefinition,
      desiredCount: 1,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [ecsSecurityGroup],
      assignPublicIp: false,
      healthCheckGracePeriod: cdk.Duration.minutes(2),
      enableExecuteCommand: true,
      circuitBreaker: {
        rollback: true,
      },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // Auto Scaling for Backend
    const backendScaling = backendService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 10,
    });

    backendScaling.scaleOnCpuUtilization('BackendCpuScaling', {
      targetUtilizationPercent: 70,
    });

    backendScaling.scaleOnMemoryUtilization('BackendMemoryScaling', {
      targetUtilizationPercent: 80,
    });

    // Auto Scaling for Frontend
    const frontendScaling = frontendService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 5,
    });

    frontendScaling.scaleOnCpuUtilization('FrontendCpuScaling', {
      targetUtilizationPercent: 70,
    });

    frontendScaling.scaleOnMemoryUtilization('FrontendMemoryScaling', {
      targetUtilizationPercent: 80,
    });

    // Route 53 Hosted Zone
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: hostedZoneId.valueAsString,
      zoneName: rootDomain,
    });

    // SSL Certificate — must cover both the frontend and backend hostnames
    // (e.g. SANs for both names, or a wildcard one level above them).
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate',
      certificateArn.valueAsString
    );

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'SemiontALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      // GET /bus/subscribe is a long-lived SSE stream. The backend heartbeats it
      // every 15s, so the 60s default would work — but leave generous headroom so a
      // replay pause or event-loop stall doesn't sever every connected client.
      // (Streams the ALB does cut are resumed by the SDK via Last-Event-ID replay.)
      idleTimeout: cdk.Duration.seconds(300),
    });

    // HTTPS Listener
    const httpsListener = alb.addListener('HttpsListener', {
      port: 443,
      open: true,
      certificates: [certificate],
    });

    // Backend origin: everything on the api hostname — HTTP routes (auth, admin,
    // exchange, content) and the event bus (/bus/emit, /bus/subscribe) — goes to
    // the backend. Hostname routing means no backend path prefix list to maintain.
    httpsListener.addTargets('Backend', {
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [backendService],
      conditions: [
        elbv2.ListenerCondition.hostHeaders([apiDomainName]),
      ],
      healthCheck: {
        path: '/api/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
        healthyHttpCodes: '200',
      },
      priority: 10,
    });

    // Frontend target group (default action): the static SPA serves every path
    // on every other hostname.
    httpsListener.addTargets('Frontend', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [frontendService],
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
        healthyHttpCodes: '200',
      },
    });

    // HTTP Listener (redirect to HTTPS)
    alb.addListener('Listener', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // Route 53 Records — one per hostname, both aliased to the ALB
    new route53.ARecord(this, 'FrontendARecord', {
      zone: hostedZone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
    });

    new route53.ARecord(this, 'BackendARecord', {
      zone: hostedZone,
      recordName: apiDomainName,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
    });

    // SNS Topic for alerts
    const alertTopic = new sns.Topic(this, 'SemiontAlerts', {
      displayName: 'Semiont Alerts',
    });

    // CloudWatch Alarms for Backend
    const backendCpuAlarm = new cloudwatch.Alarm(this, 'BackendHighCPUAlarm', {
      metric: backendService.metricCpuUtilization(),
      threshold: 80,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    backendCpuAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(alertTopic)
    );

    const backendMemoryAlarm = new cloudwatch.Alarm(this, 'BackendHighMemoryAlarm', {
      metric: backendService.metricMemoryUtilization(),
      threshold: 85,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    backendMemoryAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(alertTopic)
    );

    // CloudWatch Alarms for Frontend
    const frontendCpuAlarm = new cloudwatch.Alarm(this, 'FrontendHighCPUAlarm', {
      metric: frontendService.metricCpuUtilization(),
      threshold: 80,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    frontendCpuAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(alertTopic)
    );

    const frontendMemoryAlarm = new cloudwatch.Alarm(this, 'FrontendHighMemoryAlarm', {
      metric: frontendService.metricMemoryUtilization(),
      threshold: 85,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    frontendMemoryAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(alertTopic)
    );

    // Cost Budget
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'Semiont Monthly Budget',
        budgetLimit: {
          amount: 200,
          unit: 'USD',
        },
        timeUnit: 'MONTHLY',
        budgetType: 'COST',
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'SNS',
              address: alertTopic.topicArn,
            },
          ],
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'SNS',
              address: alertTopic.topicArn,
            },
          ],
        },
      ],
    });

    // WAF Web ACL with enhanced exclusions for uploads
    const webAcl = new wafv2.CfnWebACL(this, 'SemiontWAF', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      rules: [
        // Allow MCP OAuth callbacks with localhost (before other rules)
        {
          name: 'AllowMCPCallbacks',
          priority: 0,
          action: { allow: {} },
          statement: {
            andStatement: {
              statements: [
                {
                  byteMatchStatement: {
                    searchString: '/auth/mcp-setup',
                    fieldToMatch: { uriPath: {} },
                    textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                    positionalConstraint: 'STARTS_WITH'
                  }
                },
                {
                  orStatement: {
                    statements: [
                      {
                        byteMatchStatement: {
                          searchString: 'localhost',
                          fieldToMatch: { queryString: {} },
                          textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                          positionalConstraint: 'CONTAINS'
                        }
                      },
                      {
                        byteMatchStatement: {
                          searchString: '127.0.0.1',
                          fieldToMatch: { queryString: {} },
                          textTransformations: [{ priority: 0, type: 'NONE' }],
                          positionalConstraint: 'CONTAINS'
                        }
                      }
                    ]
                  }
                }
              ]
            }
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'MCPCallbackAllowMetric',
          },
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 10,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              excludedRules: [
                { name: 'SizeRestrictions_BODY' },
                { name: 'GenericRFI_BODY' },
                { name: 'GenericRFI_QUERYARGUMENTS' },
                { name: 'GenericRFI_URIPATH' },
                { name: 'CrossSiteScripting_BODY' },
                { name: 'RestrictedExtensions_URIPATH' },
                { name: 'EC2MetaDataSSRF_BODY' },
                { name: 'NoUserAgent_HEADER' },
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSetMetric',
          },
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 20,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
              excludedRules: [
                { name: 'Host_localhost_HEADER' },
                { name: 'PROPFIND_METHOD' },
                { name: 'ExploitablePaths_URIPATH' },
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'KnownBadInputsRuleSetMetric',
          },
        },
        {
          name: 'RateLimitRule',
          priority: 30,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitMetric',
          },
        },
      ],
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'SemiontWAF',
      },
    });

    // WAF association with ALB
    new wafv2.CfnWebACLAssociation(this, 'WAFAssociation', {
      resourceArn: alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // CloudWatch Dashboard
    const dashboard = new cloudwatch.Dashboard(this, 'SemiontDashboard', {
      dashboardName: 'Semiont-Monitoring',
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Backend Service Metrics',
        left: [backendService.metricCpuUtilization(), backendService.metricMemoryUtilization()],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Frontend Service Metrics',
        left: [frontendService.metricCpuUtilization(), frontendService.metricMemoryUtilization()],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB Metrics',
        left: [alb.metrics.requestCount(), alb.metrics.targetResponseTime()],
        width: 12,
      })
    );

    // Outputs
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: alb.loadBalancerDnsName,
      description: 'Application Load Balancer DNS Name',
    });

    new cdk.CfnOutput(this, 'SNSTopicArn', {
      value: alertTopic.topicArn,
      description: 'SNS Topic for alerts',
    });

    new cdk.CfnOutput(this, 'BackendTaskDefinitionArn', {
      value: backendTaskDefinition.taskDefinitionArn,
      description: 'Backend Task Definition ARN',
    });

    new cdk.CfnOutput(this, 'FrontendTaskDefinitionArn', {
      value: frontendTaskDefinition.taskDefinitionArn,
      description: 'Frontend Task Definition ARN',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'ECS Cluster name',
    });

    new cdk.CfnOutput(this, 'BackendServiceName', {
      value: backendService.serviceName,
      description: 'Backend ECS Service name',
    });

    new cdk.CfnOutput(this, 'BackendServiceArn', {
      value: backendService.serviceArn,
      description: 'Backend ECS Service ARN',
    });

    new cdk.CfnOutput(this, 'FrontendServiceName', {
      value: frontendService.serviceName,
      description: 'Frontend ECS Service name',
    });

    new cdk.CfnOutput(this, 'FrontendServiceArn', {
      value: frontendService.serviceArn,
      description: 'Frontend ECS Service ARN',
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: logGroup.logGroupName,
      description: 'CloudWatch Log Group name',
    });

    new cdk.CfnOutput(this, 'CustomDomainUrl', {
      value: `https://${domainName}`,
      description: 'Semiont Custom Domain URL (frontend SPA)',
    });

    new cdk.CfnOutput(this, 'BackendUrl', {
      value: `https://${apiDomainName}`,
      description: 'Semiont Backend URL (the knowledge-base origin users add in the app)',
    });

    new cdk.CfnOutput(this, 'WAFWebACLArn', {
      value: webAcl.attrArn,
      description: 'WAF Web ACL ARN',
    });

    new cdk.CfnOutput(this, 'SiteName', {
      value: siteName,
      description: 'Semiont Site Name',
    });
  }
}
