/**
 * CDK Stack Factory - Re-export from cloud package
 * 
 * This file re-exports the stack factory from the cloud package
 * to maintain backwards compatibility with existing imports.
 */

export { 
  createStack, 
  getStackConstructor, 
  getAvailableStacks,
  type StackConstructor 
} from '@semiont/cloud';