import * as path from 'path';
import { execFileSync } from 'child_process';
import { ContainerStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';
import * as fs from 'fs/promises';
import type { GraphServiceConfig } from '@semiont/core';
import { checkContainerRuntime, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Stop handler for graph database services using Docker
 * Currently supports JanusGraph
 */
const stopGraphService = async (context: ContainerStopHandlerContext): Promise<StopHandlerResult> => {
  const { service } = context;
  const serviceConfig = service.config as GraphServiceConfig;
  const graphType = serviceConfig.type;

  if (!service.quiet) {
    printInfo(`Stopping ${graphType} graph database container...`);
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
  const { service, runtime, options, containerName } = context;
  const composePath = path.join(service.projectRoot, 'docker-compose.janusgraph.yml');

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
    const output = execFileSync(runtime, ['ps', '--format', '{{.Names}}'], { encoding: 'utf-8' });
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
    return {
      success: false,
      error: 'Docker is not available',
      metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
    };
  }

  try {
    const stopTime = new Date();

    if (options.force) {
      if (!service.quiet) {
        printInfo('Force stopping JanusGraph Docker stack...');
      }

      execFileSync('docker-compose', ['-f', composePath, 'kill'], {
        stdio: service.quiet ? 'ignore' : 'inherit'
      });

      execFileSync('docker-compose', ['-f', composePath, 'down'], {
        stdio: service.quiet ? 'ignore' : 'inherit'
      });

      if (!service.quiet) {
        printSuccess('JanusGraph Docker stack force stopped');
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
      if (!service.quiet) {
        printInfo(`Stopping JanusGraph Docker stack gracefully (timeout: ${options.timeout}s)...`);
      }

      execFileSync('docker-compose', ['-f', composePath, 'stop', '-t', options.timeout.toString()], {
        stdio: service.quiet ? 'ignore' : 'inherit'
      });

      execFileSync('docker-compose', ['-f', composePath, 'down'], {
        stdio: service.quiet ? 'ignore' : 'inherit'
      });

      if (!service.quiet) {
        printSuccess('JanusGraph Docker stack stopped gracefully');
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

const preflightGraphStop = async (context: ContainerStopHandlerContext): Promise<PreflightResult> => {
  return preflightFromChecks([
    checkContainerRuntime(context.runtime),
  ]);
};

export const graphStopDescriptor: HandlerDescriptor<ContainerStopHandlerContext, StopHandlerResult> = {
  command: 'stop',
  platform: 'container',
  serviceType: 'graph',
  handler: stopGraphService,
  preflight: preflightGraphStop
};
