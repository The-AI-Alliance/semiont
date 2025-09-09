/**
 * Graph Service
 * 
 * Represents graph database systems for managing connected data and relationships.
 * Graph services handle nodes, edges, traversals, and complex network queries
 * for knowledge graphs, social networks, and semantic data models.
 * 
 * Common Use Cases:
 * - JanusGraph distributed graph database
 * - Neo4j native graph database
 * - Amazon Neptune managed graph service
 * - ArangoDB multi-model with graph support
 * - TigerGraph analytics-focused graph database
 * 
 * Default Requirements:
 * - Compute: 2048MB RAM, 1.0 CPU cores (graph operations are memory-intensive)
 * - Network: Exposes port 8182 (Gremlin) or service-specific
 * - Storage: 20GB persistent for graph data and indices
 * - Backup: Graph snapshots and incremental backups
 * 
 * Platform Adaptations:
 * - Process: Runs graph database locally with data directory
 * - Container: Graph database images with volume mounts
 * - AWS: Amazon Neptune managed graph database
 * - External: Connects to cloud graph services
 * 
 * Supports graph traversals, pattern matching, shortest path algorithms,
 * community detection, centrality measures, and semantic reasoning.
 */

import { BaseService } from '../core/base-service.js';
import { CommandExtensions } from '../core/command-result.js';
import { ServiceRequirements, RequirementPresets, mergeRequirements } from '../core/service-requirements.js';
import { COMMAND_CAPABILITY_ANNOTATIONS } from '../core/service-command-capabilities.js';
import { SERVICE_TYPES } from '../core/service-types.js';

export class GraphService extends BaseService {
  
  // =====================================================================
  // Service Requirements
  // =====================================================================
  
  override getRequirements(): ServiceRequirements {
    // Start with stateful database preset (graphs are databases)
    const baseRequirements = RequirementPresets.statefulDatabase();
    
    // Define graph-specific requirements
    const graphRequirements: ServiceRequirements = {
      storage: [{
        persistent: true,
        volumeName: `graph-data-${this.systemConfig.environment}`,
        size: this.config.storageSize || '20Gi',
        mountPath: this.getDataPath(),
        type: 'volume',
        backupEnabled: true
      }],
      network: {
        ports: [this.getPort()],
        protocol: 'tcp',
        healthCheckPort: this.getPort()
      },
      resources: {
        memory: this.config.memory || '2Gi',  // Graph operations need more memory
        cpu: this.config.cpu || '1.0',
        replicas: 1  // Graph databases are typically single instance
      },
      security: {
        secrets: this.getSecrets(),
        runAsUser: 1000,  // Non-root user
        runAsGroup: 1000,
        allowPrivilegeEscalation: false
      },
      environment: this.getEnvironmentVariables(),
      // Add capability annotations for handlers
      annotations: {
        [COMMAND_CAPABILITY_ANNOTATIONS.PROVISION]: 'true',
        'service/type': SERVICE_TYPES.GRAPH,
        'graph/type': this.config.name || 'janusgraph'
      }
    };
    
    // Merge with base requirements
    return mergeRequirements(baseRequirements, graphRequirements);
  }
  
  // =====================================================================
  // Graph-Specific Methods
  // =====================================================================
  
  /**
   * Get the port for the graph service
   */
  override getPort(): number {
    // Default ports for different graph databases
    const defaultPorts: Record<string, number> = {
      janusgraph: 8182,  // Gremlin Server
      neo4j: 7687,       // Bolt protocol
      neptune: 8182,     // Gremlin Server
      arangodb: 8529     // ArangoDB HTTP API
    };
    
    const graphType = this.config.name || 'janusgraph';
    return this.config.port || defaultPorts[graphType] || 8182;
  }
  
  /**
   * Get the data path for the graph database
   */
  private getDataPath(): string {
    const graphType = this.config.name || 'janusgraph';
    
    const dataPaths: Record<string, string> = {
      janusgraph: '/var/lib/janusgraph/data',
      neo4j: '/data',
      arangodb: '/var/lib/arangodb3'
    };
    
    return this.config.dataPath || dataPaths[graphType] || '/data';
  }
  
  /**
   * Get required secrets for the graph database
   */
  private getSecrets(): string[] {
    const graphType = this.config.name || 'janusgraph';
    
    switch (graphType) {
      case 'neo4j':
        return ['NEO4J_AUTH'];
      case 'arangodb':
        return ['ARANGO_ROOT_PASSWORD'];
      default:
        // JanusGraph typically doesn't require auth by default
        return [];
    }
  }
  
  /**
   * Get environment variables for the graph database
   */
  override getEnvironmentVariables(): Record<string, string> {
    const graphType = this.config.name || 'janusgraph';
    const env: Record<string, string> = {};
    
    switch (graphType) {
      case 'janusgraph':
        env.JAVA_OPTIONS = this.config.javaOptions || '-Xms1g -Xmx2g';
        if (this.config.storage) {
          env['janusgraph.storage.backend'] = this.config.storage;
        }
        if (this.config.index) {
          env['janusgraph.index.search.backend'] = this.config.index;
        }
        break;
        
      case 'neo4j':
        env.NEO4J_ACCEPT_LICENSE_AGREEMENT = 'yes';
        env.NEO4J_dbms_memory_heap_max__size = this.config.heapSize || '1G';
        env.NEO4J_dbms_memory_pagecache_size = this.config.pageCacheSize || '512M';
        break;
        
      case 'arangodb':
        env.ARANGO_NO_AUTH = this.config.noAuth ? '1' : '0';
        break;
    }
    
    // Add any custom environment variables
    if (this.config.environment) {
      Object.assign(env, this.config.environment);
    }
    
    return env;
  }
  
  // =====================================================================
  // Command Extensions
  // =====================================================================
  
  async getCommandExtensions(): Promise<CommandExtensions> {
    return {
      // Common graph database endpoints
      endpoint: this.getEndpoint()
    };
  }
  
  /**
   * Get the connection endpoint for the graph database
   */
  private getEndpoint(): string {
    const graphType = this.config.name || 'janusgraph';
    const host = this.config.host || 'localhost';
    const port = this.getPort();
    
    switch (graphType) {
      case 'janusgraph':
      case 'neptune':
        return `ws://${host}:${port}/gremlin`;
      case 'neo4j':
        return `bolt://${host}:${port}`;
      case 'arangodb':
        return `http://${host}:${port}`;
      default:
        return `${host}:${port}`;
    }
  }
}