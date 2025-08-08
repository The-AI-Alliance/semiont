#!/usr/bin/env node
/**
 * CDK App Entry Point for Testing
 * 
 * This file creates a CDK application for testing and synthesis.
 * For actual deployments, use the scripts package which provides
 * more sophisticated stack management and configuration loading.
 */

import { App } from 'aws-cdk-lib';
import { SemiontInfraStack } from '../index';

const app = new App();

// Create test stack for CDK synth validation
// This only tests the InfraStack since AppStack requires InfraStack outputs
new SemiontInfraStack(app, 'TestInfraStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT || '123456789012',
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});