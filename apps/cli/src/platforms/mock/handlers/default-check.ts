import { MockCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { passingPreflight } from '../../../core/handlers/preflight-utils.js';

/**
 * Check handler for mock services (used for testing)
 */
const checkMockService = async (context: MockCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service, mockState } = context;
  
  const state = mockState.get(service.name);
  const status = state?.running ? 'running' : 'stopped';
  
  // Mock platform doesn't have real logs, but we can simulate
  let logs: { recent: string[]; errors: string[] } | undefined = undefined;
  if (status === 'running' && platform && typeof platform.collectLogs === 'function') {
    const logEntries = await platform.collectLogs(service, { tail: 10 });
    if (logEntries) {
      logs = {
        recent: logEntries.map(entry => entry.message),
        errors: logEntries.filter(entry => entry.level === 'error').map(entry => entry.message)
      };
    }
  }
  
  return {
    success: true,
    status,
    platformResources: state ? {
      platform: 'mock',
      data: {
        mockId: state.id,
        mockPort: state.port
      }
    } : undefined,
    health: {
      healthy: state?.running || false,
      details: {
        message: state?.running ? 'Mock service is running' : 'Mock service is stopped'
      }
    },
    logs,
    metadata: {
      serviceType: 'default',
      mockId: state?.id,
      stateVerified: true
    }
  };
};

const baseCheckDescriptor = {
  command: 'check' as const,
  platform: 'mock' as const,
  handler: checkMockService,
  preflight: async () => passingPreflight(),
};

export const defaultCheckDescriptor: HandlerDescriptor<MockCheckHandlerContext, CheckHandlerResult> = { ...baseCheckDescriptor, serviceType: 'backend' };
export const frontendCheckDescriptor: HandlerDescriptor<MockCheckHandlerContext, CheckHandlerResult> = { ...baseCheckDescriptor, serviceType: 'frontend' };
export const databaseCheckDescriptor: HandlerDescriptor<MockCheckHandlerContext, CheckHandlerResult> = { ...baseCheckDescriptor, serviceType: 'database' };
export const graphCheckDescriptor: HandlerDescriptor<MockCheckHandlerContext, CheckHandlerResult> = { ...baseCheckDescriptor, serviceType: 'graph' };
export const workerCheckDescriptor: HandlerDescriptor<MockCheckHandlerContext, CheckHandlerResult> = { ...baseCheckDescriptor, serviceType: 'worker' };
export const inferenceCheckDescriptor: HandlerDescriptor<MockCheckHandlerContext, CheckHandlerResult> = { ...baseCheckDescriptor, serviceType: 'inference' };
export const mcpCheckDescriptor: HandlerDescriptor<MockCheckHandlerContext, CheckHandlerResult> = { ...baseCheckDescriptor, serviceType: 'mcp' };
export const stackCheckDescriptor: HandlerDescriptor<MockCheckHandlerContext, CheckHandlerResult> = { ...baseCheckDescriptor, serviceType: 'stack' };
export const filesystemCheckDescriptor: HandlerDescriptor<MockCheckHandlerContext, CheckHandlerResult> = { ...baseCheckDescriptor, serviceType: 'filesystem' };