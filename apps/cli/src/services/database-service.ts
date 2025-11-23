/**
 * Database Service
 * 
 * Represents data persistence layers including SQL and NoSQL databases.
 * Database services manage structured data storage, queries, transactions,
 * and data integrity for applications.
 * 
 * Common Use Cases:
 * - PostgreSQL, MySQL, MariaDB relational databases
 * - MongoDB, DynamoDB, Cassandra NoSQL stores
 * - Redis, Memcached caching layers
 * - Elasticsearch, Solr search engines
 * - TimescaleDB, InfluxDB time-series databases
 * 
 * Default Requirements:
 * - Compute: 1024MB RAM, 1.0 CPU cores
 * - Network: Exposes port 5432 (PostgreSQL) or service-specific
 * - Storage: 10GB persistent for data files
 * - Backup: Automated snapshots and point-in-time recovery
 * 
 * Platform Adaptations:
 * - Process: Runs database daemon locally with data directory
 * - Container: Official database images with volume mounts
 * - AWS: RDS managed instances or DynamoDB tables
 * - External: Connects to cloud databases (Atlas, Aiven, etc.)
 * 
 * Supports replication, clustering, automatic backups, monitoring,
 * connection pooling, and encryption at rest and in transit.
 */

import { BaseService } from '../core/base-service.js';
import { CommandExtensions } from '../core/command-result.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceRequirements, RequirementPresets, mergeRequirements } from '../core/service-requirements.js';
import { COMMAND_CAPABILITY_ANNOTATIONS } from '../core/service-command-capabilities.js';
import { SERVICE_TYPES } from '../core/service-types.js';

export class DatabaseService extends BaseService {
  
  // =====================================================================
  // Service Requirements
  // =====================================================================
  
  override getRequirements(): ServiceRequirements {
    // Start with stateful database preset
    const baseRequirements = RequirementPresets.statefulDatabase();
    
    // Define database-specific requirements
    const dbRequirements: ServiceRequirements = {
      storage: [{
        persistent: true,
        volumeName: `postgres-data-${this.environment}`,
        size: this.config.storageSize,  // Must be configured if needed
        mountPath: '/var/lib/postgresql/data',
        type: 'volume',
        backupEnabled: true
      }],
      network: {
        ports: [this.getPort()],
        protocol: 'tcp',
        healthCheckPort: this.getPort()
      },
      resources: {
        memory: this.config.memory,
        cpu: this.config.cpu,
        replicas: 1  // Databases are typically single instance
      },
      security: {
        secrets: ['POSTGRES_PASSWORD'],
        // Don't hardcode user IDs - let the container image decide
        // postgres:15-alpine runs as uid 70, not 999
        allowPrivilegeEscalation: false
      },
      // Pass through environment variables exactly as configured
      environment: this.config.environment || {},
      annotations: {
        // Service type declaration
        'service/type': SERVICE_TYPES.DATABASE,
        // Database supports backup and restore
        [COMMAND_CAPABILITY_ANNOTATIONS.BACKUP]: 'true',
        [COMMAND_CAPABILITY_ANNOTATIONS.RESTORE]: 'true',
        // Database doesn't support publish/update (not containerized)
        [COMMAND_CAPABILITY_ANNOTATIONS.PUBLISH]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.UPDATE]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.TEST]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.EXEC]: 'true'
      }
    };
    
    // Merge preset with specific requirements
    return mergeRequirements(baseRequirements, dbRequirements);
  }
  
  // =====================================================================
  // Service-specific configuration  
  // =====================================================================
  
  override getPort(): number {
    // Port must be explicitly configured - no defaults
    if (!this.config.port) {
      throw new Error(`Database service '${this.name}' has no port configured`);
    }
    return this.config.port;
  }
  
  override getHealthEndpoint(): string {
    return ''; // Databases don't have HTTP health endpoints
  }
  
  override getCommand(): string {
    return this.config.command || 'postgres';
  }
  
  override getImage(): string {
    // Image must be explicitly configured - no defaults
    if (!this.config.image) {
      throw new Error(`Database service '${this.name}' has no image configured`);
    }
    return this.config.image;
  }
  
  override getEnvironmentVariables(): Record<string, string> {
    // Just return what's configured - no magic, no defaults, no process.env
    return this.config.environment || {};
  }
  
  // =====================================================================
  // Service-specific hooks
  // =====================================================================
  
  protected override async checkHealth(): Promise<CommandExtensions['health']> {
    const port = this.getPort();
    const dbName = this.config.name || 'semiont';
    const user = this.config.user || 'postgres';
    
    try {
      // First check if accepting connections
      execSync(`pg_isready -h localhost -p ${port} -q`, { stdio: 'ignore' });
      
      // Try to get connection stats if possible
      let connectionCount = 0;
      let activeQueries = 0;
      try {
        const stats = execSync(
          `PGPASSWORD=${this.config.password || 'localpassword'} psql -h localhost -p ${port} -U ${user} -d ${dbName} -t -c "SELECT COUNT(*) FROM pg_stat_activity WHERE datname='${dbName}'"`,
          { encoding: 'utf-8', stdio: 'pipe' }
        ).toString().trim();
        connectionCount = parseInt(stats) || 0;
        
        const queries = execSync(
          `PGPASSWORD=${this.config.password || 'localpassword'} psql -h localhost -p ${port} -U ${user} -d ${dbName} -t -c "SELECT COUNT(*) FROM pg_stat_activity WHERE state='active' AND datname='${dbName}'"`,
          { encoding: 'utf-8', stdio: 'pipe' }
        ).toString().trim();
        activeQueries = parseInt(queries) || 0;
      } catch {
        // Can't get detailed stats, but database is up
      }
      
      return {
        healthy: true,
        details: { 
          endpoint: `postgresql://localhost:${port}/${dbName}`,
          message: 'Database accepting connections',
          connections: connectionCount,
          activeQueries
        }
      };
    } catch (error) {
      return {
        healthy: false,
        details: { 
          endpoint: `postgresql://localhost:${port}/${dbName}`,
          message: 'Database not responding',
          error: (error as Error).message
        }
      };
    }
  }
  
  protected async doCollectLogs(): Promise<CommandExtensions['logs']> {
    switch (this.platform) {
      case 'container':
        return this.collectContainerLogs();
      case 'posix':
        return this.collectProcessLogs();
      default:
        return undefined;
    }
  }
  
  private async collectProcessLogs(): Promise<CommandExtensions['logs']> {
    // PostgreSQL logs location varies by installation
    const possibleLogPaths = [
      '/var/log/postgresql/',
      '/usr/local/var/log/',
      path.join(this.config.projectRoot || this.projectRoot, 'data/logs')
    ];
    
    for (const logPath of possibleLogPaths) {
      if (fs.existsSync(logPath)) {
        try {
          const logs = execSync(`tail -50 ${logPath}/*.log 2>/dev/null`, { encoding: 'utf-8' })
            .split('\n')
            .filter(line => line.trim());
          
          return {
            recent: logs.slice(-10),
            errors: logs.filter(l => l.match(/\bERROR\b/)).slice(-10)
          };
        } catch {
          continue;
        }
      }
    }
    
    return undefined;
  }
  
  private async collectContainerLogs(): Promise<CommandExtensions['logs']> {
    const containerName = `semiont-postgres-${this.config.environment}`;
    const runtime = fs.existsSync('/var/run/docker.sock') ? 'docker' : 'podman';
    
    try {
      const logs = execSync(
        `${runtime} logs --tail 50 ${containerName} 2>&1`,
        { encoding: 'utf-8' }
      ).split('\n').filter(line => line.trim());
      
      return {
        recent: logs.slice(-10),
        errors: logs.filter(l => l.match(/\bERROR\b/)).slice(-10)
      };
    } catch {
      return undefined;
    }
  }
}