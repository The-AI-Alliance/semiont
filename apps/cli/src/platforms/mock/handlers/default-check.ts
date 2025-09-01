import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';

/**
 * Check handler for mock services (used for testing)
 */
const checkMockService = async (context: CheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service, mockState } = context;
  
  const state = mockState.get(service.name);
  const status = state?.running ? 'running' : 'stopped';
  
  // Mock platform doesn't have real logs, but we can simulate
  let logs = undefined;
  if (status === 'running' && platform && typeof platform.collectLogs === 'function') {
    logs = await platform.collectLogs(service);
  }
  
  return {
    success: true,
    status,
    platformResources: state ? {
      platform: 'mock',
      data: {
        mockId: state.id,
        port: state.port
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

/**
 * Descriptor for mock default check handler
 */
export const defaultCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  serviceType: 'default',
  handler: checkMockService
};