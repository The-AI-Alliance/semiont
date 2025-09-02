import { CheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';

/**
 * Check handler for mock services (used for testing)
 */
const checkMockService = async (context: CheckHandlerContext): Promise<CheckHandlerResult> => {
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

/**
 * Descriptor for mock default check handler
 */
export const defaultCheckDescriptor: HandlerDescriptor<CheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'mock',
  serviceType: 'default',
  handler: checkMockService
};