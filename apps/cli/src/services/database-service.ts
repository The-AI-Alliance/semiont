/**
 * Database Service - Refactored with Platform Strategy
 * 
 * Now ~40 lines instead of 499 lines!
 */

import { BaseService } from './base-service.js';
import { CheckResult } from './types.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class DatabaseServiceRefactored extends BaseService {
  
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
    
    return {
      ...baseEnv,
      POSTGRES_DB: this.config.name || 'semiont',
      POSTGRES_USER: this.config.user || 'postgres',
      POSTGRES_PASSWORD: this.config.password || 'localpassword',
      PGDATA: '/var/lib/postgresql/data'
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
    switch (this.deployment) {
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