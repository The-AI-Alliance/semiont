import * as path from 'path';
import { execSync } from 'child_process';
import { ContainerStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';
import * as fs from 'fs/promises';
import type { GraphServiceConfig } from '@semiont/core';

/**
 * Stop handler for graph database services using Docker
 * Currently supports JanusGraph
 */
const stopGraphService = async (context: ContainerStopHandlerContext): Promise<StopHandlerResult> => {
  const { service } = context;

  // Type narrowing for graph service config
  const serviceConfig = service.config as GraphServiceConfig;

  // Determine which graph database to stop from service config
  const graphType = serviceConfig.type;
  
  if (!service.quiet) {
    printInfo(`🛑 Stopping ${graphType} graph database container...`);
  }
  
  if (graphType === 'janusgraph') {
    return stopJanusGraph(context);
  }
  
  return {
    success: false,
    error: `Unsupported graph database: ${graphType}`,
    metadata: { serviceType: 'graph', serviceName: graphType }
  };
};

async function stopJanusGraph(context: ContainerStopHandlerContext): Promise<StopHandlerResult> {
  const { service, options, containerName } = context;
  const composePath = path.join(service.projectRoot, 'docker-compose.janusgraph.yml');
  
  // Check if docker-compose file exists
  if (!await fileExists(composePath)) {
    if (!service.quiet) {
      printWarning('JanusGraph is not provisioned.');
    }
    return {
      success: true,
      metadata: { 
        serviceType: 'graph', 
        serviceName: 'janusgraph',
        notProvisioned: true 
      }
    };
  }
  
  // Check if containers are running
  let runningContainers: string[] = [];
  try {
    const output = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf-8' });
    // Check for the main graph container and any additional backend containers
    const containerNames = [containerName, 'semiont-cassandra', 'semiont-elasticsearch'];
    runningContainers = containerNames.filter(name => output.includes(name));
    
    if (runningContainers.length === 0) {
      if (!service.quiet) {
        printWarning('No JanusGraph containers are running');
      }
      return {
        success: true,
        metadata: { 
          serviceType: 'graph', 
          serviceName: 'janusgraph',
          alreadyStopped: true 
        }
      };
    }
  } catch {
    // Docker might not be available
    return {
      success: false,
      error: 'Docker is not available',
      metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
    };
  }
  
  // Stop the Docker stack
  try {
    const stopTime = new Date();
    
    if (options.force) {
      // Force stop with immediate kill
      if (!service.quiet) {
        printInfo('Force stopping JanusGraph Docker stack...');
      }
      
      execSync(`docker-compose -f ${composePath} kill`, {
        stdio: service.quiet ? 'ignore' : 'inherit'
      });
      
      execSync(`docker-compose -f ${composePath} down`, {
        stdio: service.quiet ? 'ignore' : 'inherit'
      });
      
      if (!service.quiet) {
        printSuccess('✅ JanusGraph Docker stack force stopped');
      }
      
      return {
        success: true,
        stopTime,
        graceful: false,
        metadata: {
          serviceType: 'graph',
          serviceName: 'janusgraph',
          stoppedContainers: runningContainers
        }
      };
    } else {
      // Graceful stop with timeout
      if (!service.quiet) {
        printInfo(`Stopping JanusGraph Docker stack gracefully (timeout: ${options.timeout}s)...`);
      }

      execSync(`docker-compose -f ${composePath} stop -t ${options.timeout}`, {
        stdio: service.quiet ? 'ignore' : 'inherit'
      });
      
      execSync(`docker-compose -f ${composePath} down`, {
        stdio: service.quiet ? 'ignore' : 'inherit'
      });
      
      if (!service.quiet) {
        printSuccess('✅ JanusGraph Docker stack stopped gracefully');
      }
      
      return {
        success: true,
        stopTime,
        graceful: true,
        metadata: {
          serviceType: 'graph',
          serviceName: 'janusgraph',
          stoppedContainers: runningContainers
        }
      };
    }
    
  } catch (error) {
    return {
      success: false,
      error: `Failed to stop JanusGraph: ${error}`,
      metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
    };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Handler descriptor for graph database stop
 */
export const graphStopDescriptor: HandlerDescriptor<ContainerStopHandlerContext, StopHandlerResult> = {
  command: 'stop',
  platform: 'container',
  serviceType: 'graph',
  handler: stopGraphService
};