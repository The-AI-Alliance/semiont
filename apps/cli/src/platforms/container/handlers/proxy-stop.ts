import { execSync } from 'child_process';
import { ContainerStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printError, printWarning } from '../../../core/io/cli-logger.js';
import type { ProxyServiceConfig } from '@semiont/core';

/**
 * Stop handler for proxy services in containers
 */
const stopProxyService = async (context: ContainerStopHandlerContext): Promise<StopHandlerResult> => {
  const { service } = context;
  const config = service.config as ProxyServiceConfig;

  if (!service.quiet) {
    printInfo(`Stopping proxy service ${service.name} (type: ${config.type})...`);
  }

  // Container name
  const containerName = `semiont-proxy-${service.environment}`;

  try {
    // Check if container exists
    const existingContainer = execSync(`docker ps -aq -f name=${containerName}`, { encoding: 'utf-8' }).trim();

    if (!existingContainer) {
      if (!service.quiet) {
        printWarning(`Proxy container ${containerName} not found`);
      }
      return {
        success: true,
        metadata: {
          serviceType: 'proxy',
          proxyType: config.type,
          notFound: true
        }
      };
    }

    // Check if it's running
    const isRunning = execSync(`docker ps -q -f name=${containerName}`, { encoding: 'utf-8' }).trim();

    if (isRunning) {
      if (!service.quiet) {
        printInfo(`Stopping container ${containerName}...`);
      }

      // Stop the container gracefully
      execSync(`docker stop ${containerName}`, {
        stdio: service.verbose ? 'inherit' : 'pipe'
      });

      if (!service.quiet) {
        printSuccess(`Container ${containerName} stopped`);
      }
    } else {
      if (!service.quiet) {
        printInfo(`Container ${containerName} is not running`);
      }
    }

    // Remove the container
    if (!service.quiet) {
      printInfo(`Removing container ${containerName}...`);
    }

    execSync(`docker rm ${containerName}`, {
      stdio: service.verbose ? 'inherit' : 'pipe'
    });

    if (!service.quiet) {
      printSuccess(`Container ${containerName} removed`);
    }

    const metadata = {
      serviceType: 'proxy',
      proxyType: config.type,
      containerName,
      containerId: existingContainer,
      stopped: new Date().toISOString()
    };

    if (!service.quiet) {
      printSuccess(`✅ Proxy service ${service.name} stopped successfully`);
    }

    return {
      success: true,
      metadata
    };
  } catch (error) {
    printError(`Failed to stop proxy container: ${error}`);
    return {
      success: false,
      error: `Failed to stop proxy container: ${error}`,
      metadata: { serviceType: 'proxy', proxyType: config.type }
    };
  }
};

/**
 * Descriptor for proxy container stop handler
 */
export const proxyStopDescriptor: HandlerDescriptor<ContainerStopHandlerContext, StopHandlerResult> = {
  command: 'stop',
  platform: 'container',
  serviceType: 'proxy',
  handler: stopProxyService
};