/**
 * Dashboard Data Source - New Service Architecture
 * 
 * Provides real-time data collection using the Platform Strategy pattern
 */

import { ServiceFactory } from '../services/service-factory.js';
import { ServiceName, DeploymentType, ServiceConfig, CheckResult } from '../services/types.js';
import { type ServiceDeploymentInfo } from './deployment-resolver.js';
import { Config } from '../services/types.js';

import type { ServiceStatus, LogEntry, MetricData } from './dashboard-components.js';

export interface DashboardData {
  services: ServiceStatus[];
  logs: LogEntry[];
  metrics: MetricData[];
  lastUpdate: Date;
  isRefreshing: boolean;
}

export class DashboardDataSource {
  constructor(
    private environment: string,
    private serviceDeployments?: ServiceDeploymentInfo[],
    private config?: Config
  ) {}

  /**
   * Get dashboard data using the new service architecture
   */
  async getDashboardData(): Promise<DashboardData> {
    // If no service deployments provided, return empty data
    if (!this.serviceDeployments || !this.config) {
      return {
        services: [],
        logs: [],
        metrics: [],
        lastUpdate: new Date(),
        isRefreshing: false
      };
    }

    const services: ServiceStatus[] = [];
    const logs: LogEntry[] = [];
    const metrics: MetricData[] = [];

    // Use the new service implementations to check status
    for (const deployment of this.serviceDeployments) {
      try {
        const service = ServiceFactory.create(
          deployment.name as ServiceName,
          this.environment as DeploymentType,
          this.config,
          { deploymentType: this.environment as DeploymentType } as ServiceConfig
        );

        // Get status using the new check method
        const checkResult: CheckResult = await service.check();
        
        // Convert to dashboard format
        services.push({
          name: deployment.name.charAt(0).toUpperCase() + deployment.name.slice(1),
          status: this.mapStatus(checkResult.status),
          details: this.getDetails(checkResult),
          lastUpdated: new Date()
        } as ServiceStatus);

        // Add logs if available
        if (checkResult.logs?.recent) {
          checkResult.logs.recent.forEach(log => {
            logs.push({
              service: deployment.name,
              message: log,
              timestamp: new Date(),
              level: this.detectLogLevel(log)
            });
          });
        }

        // Add metrics if available
        if (checkResult.resources) {
          if (checkResult.resources.cpu !== undefined) {
            metrics.push({
              name: `${deployment.name} CPU`,
              value: checkResult.resources.cpu,
              unit: '%'
            });
          }
          if (checkResult.resources.memory !== undefined) {
            metrics.push({
              name: `${deployment.name} Memory`,
              value: checkResult.resources.memory,
              unit: 'MB'
            });
          }
          if (checkResult.resources.uptime !== undefined) {
            metrics.push({
              name: `${deployment.name} Uptime`,
              value: checkResult.resources.uptime,
              unit: 's'
            });
          }
        }

      } catch (error) {
        // Handle services that fail to check
        services.push({
          name: deployment.name,
          status: 'unknown',
          details: `Error: ${error}`,
          lastUpdated: new Date()
        });
      }
    }

    return {
      services,
      logs,
      metrics,
      lastUpdate: new Date(),
      isRefreshing: false
    };
  }

  private mapStatus(status: CheckResult['status']): 'healthy' | 'warning' | 'unhealthy' | 'unknown' {
    switch (status) {
      case 'running': return 'healthy';
      case 'stopped': return 'unhealthy';
      case 'unhealthy': return 'unhealthy';
      default: return 'unknown';
    }
  }

  private getDetails(checkResult: CheckResult): string {
    const parts = [];
    
    if (checkResult.health?.healthy) {
      parts.push('Healthy');
    }
    
    if (checkResult.resources?.pid) {
      parts.push(`PID: ${checkResult.resources.pid}`);
    }
    
    if (checkResult.resources?.containerId) {
      parts.push(`Container: ${checkResult.resources.containerId.slice(0, 12)}`);
    }
    
    if (checkResult.resources?.port) {
      parts.push(`Port: ${checkResult.resources.port}`);
    }
    
    return parts.join(', ') || checkResult.status;
  }

  private detectLogLevel(log: string): 'info' | 'warn' | 'error' {
    if (log.match(/\b(error|ERROR|Error)\b/)) return 'error';
    if (log.match(/\b(warning|WARNING|Warning|warn|WARN)\b/)) return 'warn';
    return 'info';
  }

  // Compatibility methods for web-dashboard-server
  async getServicesStatus() {
    const data = await this.getDashboardData();
    return data.services;
  }

  async getLogs(maxEntries: number = 50) {
    const data = await this.getDashboardData();
    return data.logs.slice(0, maxEntries);
  }

  async getMetrics() {
    const data = await this.getDashboardData();
    return data.metrics;
  }
}

// Re-export types for convenience
export type { ServiceStatus, LogEntry, MetricData } from './dashboard-components.js';