import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';
import { ContainerStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';
import type { GraphServiceConfig } from '@semiont/core';

/**
 * Start handler for graph database services using Docker
 * Currently supports JanusGraph
 */
const startGraphService = async (context: ContainerStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;

  // Type narrowing for graph service config
  const serviceConfig = service.config as GraphServiceConfig;

  // Determine which graph database to start from service config
  const graphType = serviceConfig.type;
  
  if (!service.quiet) {
    printInfo(`🐳 Starting ${graphType} graph database container...`);
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
  const { service, containerName } = context;
  const composePath = path.join(service.projectRoot, 'docker-compose.janusgraph.yml');
  
  // Check if docker-compose file exists
  if (!await fileExists(composePath)) {
    return {
      success: false,
      error: 'JanusGraph is not provisioned. Run: semiont provision --service graph --environment ' + service.environment,
      metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
    };
  }
  
  // Check if containers are already running
  try {
    const output = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf-8' });
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
  
  // Start the Docker stack
  try {
    if (!service.quiet) {
      printInfo('Starting JanusGraph Docker stack...');
    }
    
    execSync(`docker-compose -f ${composePath} up -d`, {
      stdio: service.quiet ? 'ignore' : 'inherit'
    });
    
    // Wait for JanusGraph to be ready
    if (!service.quiet) {
      printInfo('Waiting for JanusGraph to be ready...');
    }
    
    // JanusGraph takes a while to start, so we'll check container health
    // and give it sufficient time to initialize
    let ready = false;
    const maxAttempts = 20;  // 20 * 3 seconds = 60 seconds max
    
    for (let i = 0; i < maxAttempts; i++) {
      try {
        // Check if container is running
        const status = execSync(`docker inspect ${containerName} --format "{{.State.Status}}"`, {
          encoding: 'utf-8',
          stdio: 'pipe'
        }).trim();
        
        if (status === 'running') {
          // Check container logs for startup completion
          const logs = execSync(`docker logs ${containerName} 2>&1 | tail -20`, {
            encoding: 'utf-8',
            stdio: 'pipe'
          });
          
          // JanusGraph logs "Gremlin Server started" when ready
          // Or we can check if it's been running for at least 10 seconds
          if (logs.includes('Channel started') || logs.includes('Started') || i >= 5) {
            // Give it a few more seconds to stabilize
            await new Promise(resolve => setTimeout(resolve, 3000));
            ready = true;
            break;
          }
        }
      } catch {
        // Container might not be ready yet
      }
      
      // Wait before next attempt
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      if (!service.quiet && i > 0 && i % 5 === 0) {
        printInfo(`Still waiting... (${i * 3}s elapsed)`);
      }
    }
    
    if (!ready) {
      // Check one more time if container is at least running
      try {
        const finalStatus = execSync(`docker inspect ${containerName} --format "{{.State.Status}}"`, {
          encoding: 'utf-8',
          stdio: 'pipe'
        }).trim();
        
        if (finalStatus === 'running') {
          // Container is running, assume it's ready even if logs don't confirm
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
      // Stop containers if failed to start
      execSync(`docker-compose -f ${composePath} down`, { stdio: 'ignore' });
      
      return {
        success: false,
        error: 'JanusGraph failed to start within timeout',
        metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
      };
    }
    
    // Determine what services are running
    const runningContainers = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf-8' });
    const hasCassandra = runningContainers.includes('semiont-cassandra');
    const hasElasticsearch = runningContainers.includes('semiont-elasticsearch');
    
    if (!service.quiet) {
      printSuccess('✅ JanusGraph Docker stack started successfully!');
      printInfo('Service URLs:');
      printInfo('  Gremlin Server: ws://localhost:8182/gremlin');
      if (hasCassandra) {
        printInfo('  Cassandra: localhost:9042');
      }
      if (hasElasticsearch) {
        printInfo('  Elasticsearch: http://localhost:9200');
      }
      printInfo('');
      printInfo('To access Gremlin console:');
      printInfo(`  docker exec -it ${containerName} bin/gremlin.sh`);
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

/**
 * Handler descriptor for graph database start
 */
export const graphStartDescriptor: HandlerDescriptor<ContainerStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'container',
  serviceType: 'graph',
  handler: startGraphService
};