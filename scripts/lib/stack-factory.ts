/**
 * CDK Stack Factory - Runtime resolution of stack names to classes
 */

import * as cdk from 'aws-cdk-lib';
import { SemiontInfraStack } from '../../cloud/cdk/dist/lib/infra-stack.js';
import { SemiontAppStack } from '../../cloud/cdk/dist/lib/app-stack.js';

// Stack constructor type
export type StackConstructor = typeof SemiontInfraStack | typeof SemiontAppStack;

// Stack registry mapping string names to constructors
const STACK_REGISTRY: Record<string, StackConstructor> = {
  'SemiontInfraStack': SemiontInfraStack,
  'SemiontAppStack': SemiontAppStack
};

/**
 * Resolve a stack name to its constructor
 */
export function getStackConstructor(stackName: string): StackConstructor {
  const constructor = STACK_REGISTRY[stackName];
  if (!constructor) {
    throw new Error(`Unknown stack: ${stackName}. Available stacks: ${Object.keys(STACK_REGISTRY).join(', ')}`);
  }
  return constructor;
}

/**
 * Create a stack instance by name
 */
export function createStack(
  stackName: string, 
  scope: cdk.App, 
  id: string, 
  props?: cdk.StackProps,
  dependencies?: any
): SemiontInfraStack | SemiontAppStack {
  // Handle each stack type explicitly to satisfy TypeScript's strict typing
  if (stackName === 'SemiontInfraStack') {
    return new SemiontInfraStack(scope, id, props as any);
  } else if (stackName === 'SemiontAppStack') {
    const appProps = {
      ...props,
      ...dependencies
    };
    return new SemiontAppStack(scope, id, appProps as any);
  } else {
    throw new Error(`Unknown stack: ${stackName}. Available stacks: SemiontInfraStack, SemiontAppStack`);
  }
}

/**
 * Get all available stack names
 */
export function getAvailableStacks(): string[] {
  return Object.keys(STACK_REGISTRY);
}