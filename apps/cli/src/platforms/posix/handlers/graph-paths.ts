import * as path from 'path';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import type { GraphServiceConfig } from '@semiont/core';

/**
 * Graph service paths on POSIX platform
 * Paths are relative to the data directory
 */
export interface GraphPaths {
  dataDir: string;              // Main graph data directory
  pidFile: string;              // PID file for the graph server
  janusgraphDir: string;        // JanusGraph installation directory
  janusgraphZipPath: string;    // JanusGraph download zip path
  configPath: string;           // Server configuration file
  graphConfigPath: string;      // Graph database configuration
  gremlinServerScript: string;  // Gremlin server startup script
  gremlinShellScript: string;   // Gremlin shell script
  dataStorageDir: string;       // Actual data storage directory
}

/**
 * Get all graph paths for POSIX platform
 */
export function getGraphPaths<T>(context: BaseHandlerContext<T>): GraphPaths {
  const service = context.service;

  // Type narrowing for graph service config
  const serviceConfig = service.config as GraphServiceConfig;

  const janusgraphVersion = serviceConfig.janusgraphVersion;
  if (!janusgraphVersion) {
    throw new Error('janusgraphVersion not configured');
  }

  const dataDir = process.env.JANUSGRAPH_DATA_DIR;
  if (!dataDir) {
    throw new Error('JANUSGRAPH_DATA_DIR not configured');
  }

  const janusgraphDir = path.join(dataDir, `janusgraph-${janusgraphVersion}`);

  return {
    dataDir,
    pidFile: path.join(dataDir, 'janusgraph.pid'),
    janusgraphDir,
    janusgraphZipPath: path.join(dataDir, `janusgraph-${janusgraphVersion}.zip`),
    configPath: path.join(janusgraphDir, 'conf', 'gremlin-server', 'custom-server.yaml'),
    graphConfigPath: path.join(janusgraphDir, 'conf', 'custom-graph.properties'),
    gremlinServerScript: path.join(janusgraphDir, 'bin', 'gremlin-server.sh'),
    gremlinShellScript: path.join(janusgraphDir, 'bin', 'gremlin.sh'),
    dataStorageDir: path.join(dataDir, 'data')
  };
}