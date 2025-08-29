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

import { BaseService } from './base-service.js';
import { CheckResult } from '../commands/check.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceRequirements, RequirementPresets, mergeRequirements } from '../services/service-requirements.js';

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
        volumeName: `postgres-data-${this.systemConfig.environment}`,
        size: this.config.storageSize || '10Gi',
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
        memory: this.config.memory || '1Gi',
        cpu: this.config.cpu || '0.5',
        replicas: 1  // Databases are typically single instance
      },
      security: {
        secrets: ['POSTGRES_PASSWORD'],
        runAsUser: 999,  // postgres user
        runAsGroup: 999,
        allowPrivilegeEscalation: false
      },
      environment: {
        POSTGRES_DB: this.config.database || 'semiont',
        POSTGRES_USER: this.config.user || 'postgres',
        PGDATA: '/var/lib/postgresql/data'
      }
    };
    
    // Merge preset with specific requirements
    return mergeRequirements(baseRequirements, dbRequirements);
  }
  
  // =====================================================================
  // Service-specific configuration  
  // =====================================================================
  
  override getPort(): number {
    return this.config.port || 5432;
  }
  
  override getHealthEndpoint(): string {
    return ''; // Databases don't have HTTP health endpoints
  }
  
  override getCommand(): string {
    return this.config.command || 'postgres';
  }
  
  override getImage(): string {
    return this.config.image || 'postgres:latest';
  }
  
  override getEnvironmentVariables(): Record<string, string> {
    const baseEnv = super.getEnvironmentVariables();
    const requirements = this.getRequirements();
    
    // Merge base env with requirements env
    return {
      ...baseEnv,
      ...(requirements.environment || {}),
      // Add password from environment if available
      POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || this.config.password || 'localpassword'
    };
  }
  
  // =====================================================================
  // Service-specific hooks
  // =====================================================================
  
  protected override async checkHealth(): Promise<CheckResult['health']> {
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
        endpoint: `postgresql://localhost:${port}/${dbName}`,
        healthy: true,
        details: { 
          message: 'Database accepting connections',
          connections: connectionCount,
          activeQueries
        }
      };
    } catch (error) {
      return {
        endpoint: `postgresql://localhost:${port}/${dbName}`,
        healthy: false,
        details: { 
          message: 'Database not responding',
          error: (error as Error).message
        }
      };
    }
  }
  
  protected async doCollectLogs(): Promise<CheckResult['logs']> {
    switch (this.platform) {
      case 'container':
        return this.collectContainerLogs();
      case 'process':
        return this.collectProcessLogs();
      default:
        return undefined;
    }
  }
  
  private async collectProcessLogs(): Promise<CheckResult['logs']> {
    // PostgreSQL logs location varies by installation
    const possibleLogPaths = [
      '/var/log/postgresql/',
      '/usr/local/var/log/',
      path.join(this.config.projectRoot, 'data/logs')
    ];
    
    for (const logPath of possibleLogPaths) {
      if (fs.existsSync(logPath)) {
        try {
          const logs = execSync(`tail -50 ${logPath}/*.log 2>/dev/null`, { encoding: 'utf-8' })
            .split('\n')
            .filter(line => line.trim());
          
          return {
            recent: logs.slice(-10),
            errors: logs.filter(l => l.match(/\bERROR\b/)).length,
            warnings: logs.filter(l => l.match(/\bWARNING\b/)).length
          };
        } catch {
          continue;
        }
      }
    }
    
    return undefined;
  }
  
  private async collectContainerLogs(): Promise<CheckResult['logs']> {
    const containerName = `semiont-postgres-${this.config.environment}`;
    const runtime = fs.existsSync('/var/run/docker.sock') ? 'docker' : 'podman';
    
    try {
      const logs = execSync(
        `${runtime} logs --tail 50 ${containerName} 2>&1`,
        { encoding: 'utf-8' }
      ).split('\n').filter(line => line.trim());
      
      return {
        recent: logs.slice(-10),
        errors: logs.filter(l => l.match(/\bERROR\b/)).length,
        warnings: logs.filter(l => l.match(/\bWARNING\b/)).length
      };
    } catch {
      return undefined;
    }
  }
}