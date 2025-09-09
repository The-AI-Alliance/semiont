import { ContainerStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printWarning } from '../../../core/io/cli-logger.js';

/**
 * Generic stop handler for container services
 * Provides basic stop functionality for services without specific handlers
 */
const stopGenericService = async (context: ContainerStopHandlerContext): Promise<StopHandlerResult> => {
  const { service } = context;
  
  if (!service.quiet) {
    printWarning(`Using generic stop handler for ${service.name}`);
  }
  
  // For now, just return success as we don't have container tracking yet
  return {
    success: true,
    stopTime: new Date(),
    graceful: true,
    metadata: {
      serviceType: 'generic',
      serviceName: service.name,
      message: 'Generic stop handler - no container to stop'
    }
  };
};

/**
 * Handler descriptor for generic stop
 */
export const genericStopDescriptor: HandlerDescriptor<ContainerStopHandlerContext, StopHandlerResult> = {
  command: 'stop',
  platform: 'container',
  serviceType: 'generic',
  handler: stopGenericService
};