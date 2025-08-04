#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SemiontInfraStack } from '../lib/infra-stack';
import { SemiontAppStack } from '../lib/app-stack';
import { config } from '../../config';

const app = new cdk.App();

const env = { 
  account: config.aws.accountId, 
  region: config.aws.region 
};

// Deploy infrastructure stack first - contains persistent resources
const infraStack = new SemiontInfraStack(app, 'SemiontInfraStack', {
  env,
  description: 'Semiont Infrastructure - VPC, RDS, EFS, Secrets',
});

// Deploy app stack - contains ephemeral resources
const appStack = new SemiontAppStack(app, 'SemiontAppStack', {
  env,
  description: 'Semiont Application - ECS, ALB, WAF',
  // Pass resources directly from infra stack
  vpc: infraStack.vpc,
  fileSystem: infraStack.fileSystem,
  database: infraStack.database,
  dbCredentials: infraStack.dbCredentials,
  appSecrets: infraStack.appSecrets,
  jwtSecret: infraStack.jwtSecret,
  adminPassword: infraStack.adminPassword,
  googleOAuth: infraStack.googleOAuth,
  githubOAuth: infraStack.githubOAuth,
  adminEmails: infraStack.adminEmails,
  ecsSecurityGroup: infraStack.ecsSecurityGroup,
  albSecurityGroup: infraStack.albSecurityGroup,
});

// App stack depends on infra stack
appStack.addDependency(infraStack);