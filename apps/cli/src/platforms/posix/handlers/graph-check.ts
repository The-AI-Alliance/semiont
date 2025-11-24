import { StateManager } from '../../../core/state-manager.js';
import { isPortInUse } from '../../../core/io/network-utils.js';
import { execSync } from 'child_process';
import { PosixCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import type { GraphServiceConfig } from '@semiont/core';

/**
 * Check handler for POSIX graph database services
 * Supports JanusGraph, Neo4j, and other graph databases
 */
const checkGraphProcess = async (context: PosixCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service } = context;

  // Type narrowing for graph service config
  const config = service.config as GraphServiceConfig;
  const graphType = config.type;

  // Load saved state
  const savedState = await StateManager.load(
    service.projectRoot,
    service.environment,
    service.name
  );

  let status: 'running' | 'stopped' | 'unhealthy' = 'stopped';
  let pid: number | undefined;

  // Check if saved process is running
  if (savedState?.resources?.platform === 'posix' &&
      savedState.resources.data.pid &&
      StateManager.isProcessRunning(savedState.resources.data.pid)) {
    pid = savedState.resources.data.pid;
    status = 'running';
  } else {
    // Get port from config
    const port = config.port;
    
    if (port && await isPortInUse(port)) {
      // Try to find the PID using the port
      try {
        const output = process.platform === 'darwin'
          ? execSync(`lsof -ti:${port}`, { encoding: 'utf-8' })
          : execSync(`fuser ${port}/tcp 2>/dev/null | awk '{print $2}'`, { encoding: 'utf-8' });
        
        const foundPid = parseInt(output.trim());
        if (!isNaN(foundPid)) {
          pid = foundPid;
          status = 'running';
        } else {
          status = 'running';
          // Graph database is running but we couldn't determine the PID
        }
      } catch {
        status = 'running';
        // Graph database is running but we couldn't determine the PID
      }
    }
  }
  
  // Graph database health check - check if port is responding
  let health = {
    healthy: status === 'running',
    details: {
      port: config.port,
      graphType,
      status: status === 'running' ? 'accepting connections' : 'not running',
      endpoint: getGraphEndpoint(graphType, config.port)
    }
  };

  const platformResources = pid ? {
    platform: 'posix' as const,
    data: {
      pid,
      port: config.port,
      graphType
    }
  } : undefined;
  
  // Collect logs if running
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
    platformResources,
    health,
    logs,
    metadata: {
      serviceType: 'graph',
      graphType,
      stateVerified: true
    }
  };
};

/**
 * Get the connection endpoint for the graph database
 */
function getGraphEndpoint(graphType: string, port?: number): string {
  const host = 'localhost';
  const actualPort = port ?? getDefaultPort(graphType);
  
  switch (graphType) {
    case 'janusgraph':
    case 'neptune':
      return `ws://${host}:${actualPort}/gremlin`;
    case 'neo4j':
      return `bolt://${host}:${actualPort}`;
    case 'arangodb':
      return `http://${host}:${actualPort}`;
    default:
      return `${host}:${actualPort}`;
  }
}

function getDefaultPort(graphType: string): number {
  const ports: Record<string, number> = {
    janusgraph: 8182,
    neo4j: 7687,
    neptune: 8182,
    arangodb: 8529
  };
  return ports[graphType];
}

/**
 * Descriptor for POSIX graph check handler
 */
export const graphCheckDescriptor: HandlerDescriptor<PosixCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'graph',
  handler: checkGraphProcess
};