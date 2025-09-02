import { StartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { PlatformResources } from '../../platform-resources.js';
import { printInfo } from '../../../core/io/cli-logger.js';

/**
 * Start handler for default services on Mock platform
 */
const startMockService = async (context: StartHandlerContext): Promise<StartHandlerResult> => {
  const { service, mockData, mockState } = context;
  const requirements = service.getRequirements();
  
  // Check if there's existing mock state for this service
  const existingState = mockState?.get(service.name);
  if (existingState?.simulateFailure) {
    return {
      success: false,
      error: existingState.failureMessage || 'Mock service failed to start',
      metadata: {
        serviceType: 'default',
        mock: true,
        simulatedFailure: true,
        serviceName: service.name
      }
    };
  }
  
  // Mock platform simulates service startup
  if (!service.quiet) {
    printInfo(`[MOCK] Starting service: ${service.name}`);
  }
  
  // Simulate startup delay if configured
  const startupDelay = mockData?.startupDelay || 100;
  await new Promise(resolve => setTimeout(resolve, startupDelay));
  
  // Check if mock should simulate failure
  if (mockData?.simulateFailure) {
    return {
      success: false,
      error: mockData.failureMessage || 'Mock service failed to start',
      metadata: {
        serviceType: 'default',
        mock: true,
        simulatedFailure: true,
        serviceName: service.name
      }
    };
  }
  
  // Build mock endpoint if service has network requirements
  let endpoint: string | undefined;
  if (requirements.network?.ports && requirements.network.ports.length > 0) {
    const port = requirements.network.ports[0];
    endpoint = mockData?.endpoint || `http://mock-localhost:${port}`;
  } else if (mockData?.endpoint) {
    endpoint = mockData.endpoint;
  }
  
  // Create mock resources
  const mockId = mockData?.id || `mock-${service.name}-${Date.now()}`;
  const mockResources: PlatformResources = {
    platform: 'mock',
    data: {
      mockId,
      mockPid: 99999,  // Fake PID for mock
      mockPort: requirements.network?.ports?.[0],
      mockEndpoint: endpoint
    }
  };
  
  // Simulate various service states based on mock data
  const serviceState = mockData?.state || 'running';
  const healthStatus = mockData?.healthStatus || 'healthy';
  
  if (!service.quiet) {
    printInfo(`[MOCK] Service ${service.name} started successfully`);
    if (endpoint) {
      printInfo(`[MOCK] Endpoint: ${endpoint}`);
    }
    printInfo(`[MOCK] State: ${serviceState}, Health: ${healthStatus}`);
  }
  
  // Use existing state's startTime if available, otherwise create new
  const startTime = existingState?.startTime || new Date();
  
  // Update mock state with running service info
  if (mockState) {
    mockState.set(service.name, {
      ...existingState,
      id: mockId,
      running: true,
      startTime,
      endpoint,
      state: serviceState,
      healthStatus
    });
  }
  
  return {
    success: true,
    startTime,
    endpoint,
    resources: mockResources,
    metadata: {
      serviceType: 'default',
      mock: true,
      mockId,
      serviceName: service.name,
      serviceState,
      healthStatus,
      startupDelay,
      endpoint,
      ports: requirements.network?.ports,
      environment: service.environment,
      mockData: mockData || {}
    }
  };
};

/**
 * Descriptor for default mock service start handler
 */
export const defaultStartDescriptor: HandlerDescriptor<StartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'mock',
  serviceType: 'default',
  handler: startMockService
};