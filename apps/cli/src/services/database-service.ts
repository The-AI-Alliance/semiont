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
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceRequirements, RequirementPresets, mergeRequirements } from '../core/service-requirements.js';
import { COMMAND_CAPABILITY_ANNOTATIONS } from '../core/service-command-capabilities.js';
import { SERVICE_TYPES } from '../core/service-types.js';
import { type DatabaseServiceConfig } from '@semiont/core';

export class DatabaseService extends BaseService {

  // Type-narrowed config accessor
  private get typedConfig(): DatabaseServiceConfig {
    return this.config as DatabaseServiceConfig;
  }
  
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
        size: this.typedConfig.storageSize,  // Must be configured if needed
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
        memory: this.typedConfig.resources?.memory,
        cpu: this.typedConfig.resources?.cpu,
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
        'service/type': SERVICE_TYPES.DATABASE,
        [COMMAND_CAPABILITY_ANNOTATIONS.BACKUP]: 'true',
        [COMMAND_CAPABILITY_ANNOTATIONS.RESTORE]: 'true',
        [COMMAND_CAPABILITY_ANNOTATIONS.PUBLISH]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.UPDATE]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.TEST]: 'false',
        [COMMAND_CAPABILITY_ANNOTATIONS.EXEC]: 'true',
        // When on external platform, only check and watch apply
        ...(this.platform === 'external' ? {
          [COMMAND_CAPABILITY_ANNOTATIONS.START]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.STOP]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.RESTART]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.PROVISION]: 'false',
          [COMMAND_CAPABILITY_ANNOTATIONS.CONFIGURE]: 'false',
        } : {}),
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
    if (this.config.environment && Object.keys(this.config.environment).length > 0) {
      return this.config.environment;
    }
    // Build postgres container env vars from flat config fields
    const vars: Record<string, string> = {};
    if (this.typedConfig.user) vars['POSTGRES_USER'] = this.typedConfig.user;
    if (this.typedConfig.password) vars['POSTGRES_PASSWORD'] = this.typedConfig.password;
    if (this.typedConfig.name) vars['POSTGRES_DB'] = this.typedConfig.name;
    return vars;
  }
  
  // =====================================================================
  // Service-specific hooks
  // =====================================================================
  
  protected override async checkHealth(): Promise<CommandExtensions['health']> {
    const port = this.getPort();
    const dbName = this.typedConfig.name || 'semiont';
    const user = this.typedConfig.user || 'postgres';
    
    try {
      // First check if accepting connections
      execFileSync('pg_isready', ['-h', 'localhost', '-p', String(port), '-q'], { stdio: 'ignore' });

      // Try to get connection stats if possible
      let connectionCount = 0;
      let activeQueries = 0;
      const pgEnv = { ...process.env, PGPASSWORD: this.typedConfig.password || 'localpassword' };
      try {
        const stats = execFileSync('psql', [
          '-h', 'localhost', '-p', String(port), '-U', user, '-d', dbName, '-t',
          '-c', `SELECT COUNT(*) FROM pg_stat_activity WHERE datname='${dbName}'`
        ], { encoding: 'utf-8', stdio: 'pipe', env: pgEnv }).toString().trim();
        connectionCount = parseInt(stats) || 0;

        const queries = execFileSync('psql', [
          '-h', 'localhost', '-p', String(port), '-U', user, '-d', dbName, '-t',
          '-c', `SELECT COUNT(*) FROM pg_stat_activity WHERE state='active' AND datname='${dbName}'`
        ], { encoding: 'utf-8', stdio: 'pipe', env: pgEnv }).toString().trim();
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
      path.join(this.projectRoot!, 'data/logs')
    ];
    
    for (const logPath of possibleLogPaths) {
      if (fs.existsSync(logPath)) {
        try {
          const logFiles = fs.readdirSync(logPath).filter((f: string) => f.endsWith('.log'));
          if (logFiles.length === 0) continue;
          const latestLogFile = path.join(logPath, logFiles[logFiles.length - 1]);
          const logs = execFileSync('tail', ['-50', latestLogFile], { encoding: 'utf-8' })
            .split('\n')
            .filter((line: string) => line.trim());

          return {
            recent: logs.slice(-10),
            errors: logs.filter((l: string) => l.match(/\bERROR\b/)).slice(-10)
          };
        } catch {
          continue;
        }
      }
    }
    
    return undefined;
  }
  
  private async collectContainerLogs(): Promise<CommandExtensions['logs']> {
    const containerName = `semiont-postgres-${this.environment}`;
    const runtime = fs.existsSync('/var/run/docker.sock') ? 'docker' : 'podman';
    
    try {
      const logs = execFileSync(runtime, ['logs', '--tail', '50', containerName], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).split('\n').filter((line: string) => line.trim());

      return {
        recent: logs.slice(-10),
        errors: logs.filter((l: string) => l.match(/\bERROR\b/)).slice(-10)
      };
    } catch {
      return undefined;
    }
  }
}