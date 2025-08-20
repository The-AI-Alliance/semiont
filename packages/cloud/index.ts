/**
 * Semiont CDK Stack Exports
 * 
 * Main entry point for the CDK infrastructure stacks
 */

export { SemiontInfraStack } from './lib/infra-stack';
export { SemiontAppStack } from './lib/app-stack';
export { 
  createStack, 
  getStackConstructor, 
  getAvailableStacks,
  type StackConstructor 
} from './lib/stack-factory';

// Re-export CDK classes for consuming packages
export { App, DefaultStackSynthesizer } from 'aws-cdk-lib';