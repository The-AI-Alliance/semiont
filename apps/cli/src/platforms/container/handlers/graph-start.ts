import * as fs from 'fs/promises';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ContainerStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';
import type { GraphServiceConfig } from '@semiont/core';
import { checkContainerRuntime, checkPortFree, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Start handler for graph database services using Docker
 * Currently supports JanusGraph
 */
const startGraphService = async (context: ContainerStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const serviceConfig = service.config as GraphServiceConfig;
  const graphType = serviceConfig.type;

  if (!service.quiet) {
    printInfo(`Starting ${graphType} graph database container...`);
  }

  if (graphType === 'janusgraph') {
    return startJanusGraph(context);
  }

  return {
    success: false,
    error: `Unsupported graph database: ${graphType}`,
    metadata: { serviceType: 'graph', serviceName: graphType }
  };
};

async function startJanusGraph(context: ContainerStartHandlerContext): Promise<StartHandlerResult> {
  const { service, runtime, containerName } = context;
  const composePath = path.join(service.projectRoot, 'docker-compose.janusgraph.yml');

  if (!await fileExists(composePath)) {
    return {
      success: false,
      error: 'JanusGraph is not provisioned. Run: semiont provision --service graph --environment ' + service.environment,
      metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
    };
  }

  // Check if containers are already running
  try {
    const output = execFileSync(runtime, ['ps', '--format', '{{.Names}}'], { encoding: 'utf-8' });
    if (output.includes(containerName)) {
      if (!service.quiet) {
        printWarning('JanusGraph container is already running');
      }
      return {
        success: true,
        metadata: {
          serviceType: 'graph',
          serviceName: 'janusgraph',
          containerId: containerName,
          alreadyRunning: true
        }
      };
    }
  } catch {
    // Docker might not be available
  }

  try {
    if (!service.quiet) {
      printInfo('Starting JanusGraph Docker stack...');
    }

    execFileSync('docker-compose', ['-f', composePath, 'up', '-d'], {
      stdio: service.quiet ? 'ignore' : 'inherit'
    });

    if (!service.quiet) {
      printInfo('Waiting for JanusGraph to be ready...');
    }

    let ready = false;
    const maxAttempts = 20;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const status = execFileSync(
          runtime, ['inspect', containerName, '--format', '{{.State.Status}}'],
          { encoding: 'utf-8', stdio: 'pipe' }
        ).trim();

        if (status === 'running') {
          const logs = execFileSync(
            runtime, ['logs', '--tail', '20', containerName],
            { encoding: 'utf-8', stdio: 'pipe' }
          );

          if (logs.includes('Channel started') || logs.includes('Started') || i >= 5) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            ready = true;
            break;
          }
        }
      } catch {
        // Container might not be ready yet
      }

      await new Promise(resolve => setTimeout(resolve, 3000));

      if (!service.quiet && i > 0 && i % 5 === 0) {
        printInfo(`Still waiting... (${i * 3}s elapsed)`);
      }
    }

    if (!ready) {
      try {
        const finalStatus = execFileSync(
          runtime, ['inspect', containerName, '--format', '{{.State.Status}}'],
          { encoding: 'utf-8', stdio: 'pipe' }
        ).trim();

        if (finalStatus === 'running') {
          ready = true;
          if (!service.quiet) {
            printWarning('JanusGraph container is running but may still be initializing');
          }
        }
      } catch {
        // Container doesn't exist
      }
    }

    if (!ready) {
      execFileSync('docker-compose', ['-f', composePath, 'down'], { stdio: 'ignore' });
      return {
        success: false,
        error: 'JanusGraph failed to start within timeout',
        metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
      };
    }

    const runningContainers = execFileSync(runtime, ['ps', '--format', '{{.Names}}'], { encoding: 'utf-8' });
    const hasCassandra = runningContainers.includes('semiont-cassandra');
    const hasElasticsearch = runningContainers.includes('semiont-elasticsearch');

    if (!service.quiet) {
      printSuccess('JanusGraph Docker stack started successfully!');
      printInfo('Service URLs:');
      printInfo('  Gremlin Server: ws://localhost:8182/gremlin');
      if (hasCassandra) printInfo('  Cassandra: localhost:9042');
      if (hasElasticsearch) printInfo('  Elasticsearch: http://localhost:9200');
      printInfo('');
      printInfo('To access Gremlin console:');
      printInfo(`  ${runtime} exec -it ${containerName} bin/gremlin.sh`);
    }

    return {
      success: true,
      metadata: {
        serviceType: 'graph',
        serviceName: 'janusgraph',
        containerId: containerName,
        url: 'ws://localhost:8182/gremlin',
        storage: hasCassandra ? 'cassandra' : 'berkeleydb',
        index: hasElasticsearch ? 'elasticsearch' : 'none',
        urls: {
          gremlin: 'ws://localhost:8182/gremlin',
          ...(hasCassandra && { cassandra: 'localhost:9042' }),
          ...(hasElasticsearch && { elasticsearch: 'http://localhost:9200' })
        }
      }
    };

  } catch (error) {
    return {
      success: false,
      error: `Failed to start JanusGraph: ${error}`,
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

const preflightGraphStart = async (context: ContainerStartHandlerContext): Promise<PreflightResult> => {
  const { runtime, service } = context;
  const serviceConfig = service.config as GraphServiceConfig;
  const port = serviceConfig.port || 8182;
  return preflightFromChecks([
    checkContainerRuntime(runtime),
    await checkPortFree(port),
  ]);
};

export const graphStartDescriptor: HandlerDescriptor<ContainerStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'container',
  serviceType: 'graph',
  handler: startGraphService,
  preflight: preflightGraphStart
};
