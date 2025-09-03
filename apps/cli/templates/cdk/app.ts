#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { SemiontDataStack } from './data-stack';
import { SemiontAppStack } from './app-stack';

const app = new cdk.App();

// Get configuration from context and environment
const stackType = app.node.tryGetContext('stack-type') || 'all';
const environment = app.node.tryGetContext('environment') || process.env.SEMIONT_ENV || 'production';

// Load configurations using absolute paths from the project root
// Use process.cwd() which is the project root when CDK executes
const projectRoot = process.cwd();
const semiontConfig = require(path.join(projectRoot, 'semiont.json'));
const envConfig = require(path.join(projectRoot, 'environments', `${environment}.json`));

// Stack properties
const stackProps = {
  env: {
    account: envConfig.aws?.accountId || process.env.CDK_DEFAULT_ACCOUNT,
    region: envConfig.aws?.region || process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  synthesizer: new cdk.DefaultStackSynthesizer({
    qualifier: 'hnb659fds'
  })
};

// Set CDK context with configuration values
app.node.setContext('environment', environment);
app.node.setContext('siteName', semiontConfig.site?.siteName || 'Semiont');
app.node.setContext('domain', semiontConfig.site?.domain || 'example.com');
app.node.setContext('rootDomain', semiontConfig.site?.domain?.split('.').slice(-2).join('.') || 'example.com');
app.node.setContext('adminEmail', semiontConfig.site?.adminEmail || 'admin@example.com');
app.node.setContext('oauthAllowedDomains', semiontConfig.site?.oauthAllowedDomains || ['example.com']);
app.node.setContext('databaseName', semiontConfig.services?.database?.name || 'semiont');
app.node.setContext('certificateArn', envConfig.aws?.certificateArn);
app.node.setContext('hostedZoneId', envConfig.aws?.hostedZoneId);
app.node.setContext('backendImageUri', envConfig.services?.backend?.image);
app.node.setContext('frontendImageUri', envConfig.services?.frontend?.image);
app.node.setContext('nodeEnv', envConfig.env?.NODE_ENV || 'production');

// Create stacks based on stack-type context
if (stackType === 'data' || stackType === 'all') {
  new SemiontDataStack(app, 'SemiontDataStack', stackProps);
}

if (stackType === 'app' || stackType === 'all') {
  // App stack will import resources from data stack via CloudFormation exports
  new SemiontAppStack(app, 'SemiontAppStack', stackProps);
}

app.synth();