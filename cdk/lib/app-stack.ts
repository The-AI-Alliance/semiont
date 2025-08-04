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
import { config } from '../../config';

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

    // Use resources passed as properties
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

    // Parameters for configuration
    const domainName = config.site.domain;

    const certificateArn = new cdk.CfnParameter(this, 'CertificateArn', {
      type: 'String', 
      default: props.certificateArn || config.aws.certificateArn,
      description: 'ACM Certificate ARN for HTTPS'
    });

    const hostedZoneId = new cdk.CfnParameter(this, 'HostedZoneId', {
      type: 'String',
      default: props.hostedZoneId || config.aws.hostedZoneId, 
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
    // This is a known issue in CDK's internal implementation and can be safely ignored.
    const backendTaskDefinition = new ecs.FargateTaskDefinition(this, 'SemiontBackendTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });
    
    // Frontend Task Definition
    const frontendTaskDefinition = new ecs.FargateTaskDefinition(this, 'SemiontFrontendTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // Add EFS volume to backend task definition for uploads
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

    // IAM role for backend tasks to access Secrets Manager
    backendTaskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:GetSecretValue',
        ],
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
    
    // IAM role for frontend tasks (minimal permissions)
    frontendTaskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:GetSecretValue',
        ],
        resources: [
          appSecrets.secretArn,
          googleOAuth.secretArn,
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

    // Backend container - use ECR image or default
    const backendImageUri = this.node.tryGetContext('backendImageUri');
    const backendImage = backendImageUri 
      ? ecs.ContainerImage.fromEcrRepository(
          ecr.Repository.fromRepositoryName(this, 'BackendEcrRepo', 'semiont-backend'),
          backendImageUri.split(':')[1] || 'latest'
        )
      : ecs.ContainerImage.fromEcrRepository(
          ecr.Repository.fromRepositoryName(this, 'BackendEcrRepoDefault', 'semiont-backend'),
          'latest'
        );
    
    const backendContainer = backendTaskDefinition.addContainer('semiont-backend', {
      image: backendImage,
      environment: {
        NODE_ENV: config.app.nodeEnv,
        DB_HOST: database.instanceEndpoint.hostname,
        DB_PORT: database.instanceEndpoint.port.toString(),
        DB_NAME: config.aws.database.name,
        PORT: '4000',
        API_PORT: '4000',
        CORS_ORIGIN: `https://${domainName}`,
        FRONTEND_URL: `https://${domainName}`,
        AWS_REGION: this.region,
        // Configuration for OAuth
        SITE_NAME: config.site.siteName,
        DOMAIN: config.site.domain,
        OAUTH_ALLOWED_DOMAINS: config.site.oauthAllowedDomains.join(','),
      }, 
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(dbCredentials, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbCredentials, 'password'),
        JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret, 'jwtSecret'),
        SESSION_SECRET: ecs.Secret.fromSecretsManager(appSecrets, 'sessionSecret'),
        GOOGLE_CLIENT_ID: ecs.Secret.fromSecretsManager(googleOAuth, 'clientId'),
        GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(googleOAuth, 'clientSecret'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'semiont-backend',
        logGroup,
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "require(\'http\').get(\'http://localhost:4000/api/health\', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.minutes(1),
      },
    });

    backendContainer.addPortMappings({
      containerPort: 4000,
    });

    // Mount EFS volume for uploads
    backendContainer.addMountPoints({
      sourceVolume: 'efs-volume',
      containerPath: '/app/uploads',
      readOnly: false,
    });

    // Frontend container - use ECR image or default  
    const frontendImageUri = this.node.tryGetContext('frontendImageUri');
    const frontendImage = frontendImageUri
      ? ecs.ContainerImage.fromEcrRepository(
          ecr.Repository.fromRepositoryName(this, 'FrontendEcrRepo', 'semiont-frontend'),
          frontendImageUri.split(':')[1] || 'latest'
        )
      : ecs.ContainerImage.fromEcrRepository(
          ecr.Repository.fromRepositoryName(this, 'FrontendEcrRepoDefault', 'semiont-frontend'),
          'latest'
        );
    
    const frontendContainer = frontendTaskDefinition.addContainer('semiont-frontend', {
      image: frontendImage,
      environment: {
        NODE_ENV: config.app.nodeEnv,
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
        // Public environment variables (available to browser)
        NEXT_PUBLIC_API_URL: `https://${domainName}`,
        NEXT_PUBLIC_SITE_NAME: config.site.siteName,
        NEXT_PUBLIC_DOMAIN: config.site.domain,
        NEXT_PUBLIC_OAUTH_ALLOWED_DOMAINS: config.site.oauthAllowedDomains.join(','),
        // NextAuth configuration
        NEXTAUTH_URL: `https://${domainName}`,
      },
      secrets: {
        NEXTAUTH_SECRET: ecs.Secret.fromSecretsManager(appSecrets, 'nextAuthSecret'),
        GOOGLE_CLIENT_ID: ecs.Secret.fromSecretsManager(googleOAuth, 'clientId'),
        GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(googleOAuth, 'clientSecret'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'semiont-frontend',
        logGroup,
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "require(\'http\').get(\'http://localhost:3000\', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"'],
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
      zoneName: config.aws.rootDomain,
    });

    // SSL Certificate
    const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', 
      certificateArn.valueAsString
    );

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'SemiontALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
    });

    // HTTPS Listener
    const httpsListener = alb.addListener('HttpsListener', {
      port: 443,
      open: true,
      certificates: [certificate],
    });

    // Backend API target group for core API endpoints
    httpsListener.addTargets('BackendAPI', {
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [backendService],
      conditions: [
        elbv2.ListenerCondition.pathPatterns([
          '/api/health', 
          '/api/hello*', 
          '/api/status', 
          '/api/admin/*',  // Admin endpoints
          '/api'           // API documentation endpoint
        ]),
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

    // Backend OAuth endpoints (higher priority than NextAuth catch-all)
    httpsListener.addTargets('BackendOAuth', {
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [backendService],
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/auth/google', '/api/auth/me', '/api/auth/logout']),
      ],
      healthCheck: {
        path: '/api/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
        healthyHttpCodes: '200',
      },
      priority: 20,
    });

    // NextAuth.js routes (lower priority, catches remaining /api/auth/* paths)
    httpsListener.addTargets('NextAuth', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [frontendService],
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/auth/*']),
      ],
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
        healthyHttpCodes: '200',
      },
      priority: 30,
    });

    // Frontend target group (default action for all other paths)
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

    // Route 53 Record
    new route53.ARecord(this, 'SemiontARecord', {
      zone: hostedZone,
      recordName: 'wiki',
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
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
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
          priority: 2,
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
          priority: 3,
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
      description: 'Semiont Custom Domain URL',
    });

    new cdk.CfnOutput(this, 'WAFWebACLArn', {
      value: webAcl.attrArn,
      description: 'WAF Web ACL ARN',
    });

    new cdk.CfnOutput(this, 'SiteName', {
      value: config.site.siteName,
      description: 'Semiont Site Name',
    });
  }
}