import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import { PosixStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';
import { getGraphPaths } from './graph-paths.js';
import type { GraphServiceConfig } from '@semiont/core';

/**
 * Start handler for graph database services on POSIX systems
 * Currently supports JanusGraph
 */
const startGraphService = async (context: PosixStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;

  // Type narrowing for graph service config
  const serviceConfig = service.config as GraphServiceConfig;

  // Determine which graph database to start from service config
  const graphType = serviceConfig.type;
  
  if (!service.quiet) {
    printInfo(`🚀 Starting ${graphType} graph database...`);
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

async function startJanusGraph(context: PosixStartHandlerContext): Promise<StartHandlerResult> {
  const { service } = context;

  const paths = getGraphPaths(context);
  const {
    janusgraphDir,
    pidFile,
    configPath,
    graphConfigPath: graphConfig,
    gremlinServerScript: gremlinServer,
    gremlinShellScript
  } = paths;

  if (!await fileExists(janusgraphDir)) {
    return {
      success: false,
      error: 'JanusGraph is not provisioned. Run: semiont provision --service janusgraph',
      metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
    };
  }

  if (await fileExists(pidFile)) {
    const pid = await fs.readFile(pidFile, 'utf-8');
    try {
      process.kill(parseInt(pid), 0);
      if (!service.quiet) {
        printWarning('JanusGraph is already running');
      }
      return {
        success: true,
        metadata: {
          serviceType: 'graph',
          serviceName: 'janusgraph',
          pid: parseInt(pid),
          alreadyRunning: true
        }
      };
    } catch {
      await fs.unlink(pidFile);
    }
  }

  if (!await fileExists(configPath)) {
    throw new Error('JanusGraph server config not found. Run: semiont provision --service janusgraph');
  }

  const child = spawn(gremlinServer, [configPath], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      JAVA_OPTIONS: '-Xms1g -Xmx2g'
    }
  });
  
  // Save PID
  await fs.writeFile(pidFile, child.pid!.toString());
  
  // Wait for server to be ready
  let ready = false;
  const maxAttempts = 30;
  
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Try to connect to Gremlin server
    try {
      const { execSync } = await import('child_process');
      execSync(`${gremlinShellScript} -e "g.V().count()"`, {
        stdio: 'ignore',
        timeout: 5000
      });
      ready = true;
      break;
    } catch {
      // Not ready yet
    }
  }
  
  if (!ready) {
    // Clean up if failed to start
    try {
      process.kill(child.pid!);
      await fs.unlink(pidFile);
    } catch {}
    
    return {
      success: false,
      error: 'JanusGraph failed to start within timeout',
      metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
    };
  }
  
  // Load configuration to determine what's running
  let storageBackend = 'berkeleydb';
  let indexBackend = 'none';
  
  if (await fileExists(graphConfig)) {
    const config = await fs.readFile(graphConfig, 'utf-8');
    if (config.includes('storage.backend=cql')) {
      storageBackend = 'cassandra';
    }
    if (config.includes('index.search.backend=elasticsearch')) {
      indexBackend = 'elasticsearch';
    }
  }
  
  if (!service.quiet) {
    printSuccess('✅ JanusGraph started successfully!');
    printInfo('Service URLs:');
    printInfo('  Gremlin Server: ws://localhost:8182/gremlin');
    printInfo(`  Storage: ${storageBackend}`);
    printInfo(`  Index: ${indexBackend}`);
  }
  
  return {
    success: true,
    metadata: {
      serviceType: 'graph',
      serviceName: 'janusgraph',
      pid: child.pid!,
      url: 'ws://localhost:8182/gremlin',
      storage: storageBackend,
      index: indexBackend
    }
  };
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
export const graphStartDescriptor: HandlerDescriptor<PosixStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'posix',
  serviceType: 'graph',
  handler: startGraphService
};