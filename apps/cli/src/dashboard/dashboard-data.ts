/**
 * Dashboard Data Source - New Service Architecture
 * 
 * Provides real-time data collection using the Platform Strategy pattern
 */

import { ServiceFactory } from '../services/service-factory.js';
import { ServiceName } from '../services/service-interface.js';
import { CheckResult } from '../commands/check.js';
import { ServiceConfig } from '../lib/cli-config.js';
import { type ServicePlatformInfo, Platform } from '../platforms/platform-resolver.js';
import { Config } from '../lib/cli-config.js';
import { isPlatformResources } from '../platforms/platform-resources.js';

import type { ServiceStatus, LogEntry, MetricData } from '../dashboard/dashboard-components.js';

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
    private serviceDeployments?: ServicePlatformInfo[],
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
          this.environment as Platform,
          this.config,
          { platform: this.environment as Platform } as ServiceConfig
        );

        // Get platform and delegate check to it
        const { PlatformFactory } = await import('../platforms/index.js');
        const platform = PlatformFactory.getPlatform(deployment.platform);
        const checkResult: CheckResult = await platform.check(service);
        
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

        // Add metrics if available (these would typically come from health checks or monitoring)
        // Note: cpu, memory, and uptime are not typically stored in resources
        // They would come from runtime monitoring. For now, we'll skip these
        // unless they're added to the health check results.
        if (checkResult.health?.details) {
          const details = checkResult.health.details;
          if (details.cpu !== undefined) {
            metrics.push({
              name: `${deployment.name} CPU`,
              value: details.cpu,
              unit: '%'
            });
          }
          if (details.memory !== undefined) {
            metrics.push({
              name: `${deployment.name} Memory`,
              value: details.memory,
              unit: 'MB'
            });
          }
          if (details.uptime !== undefined) {
            metrics.push({
              name: `${deployment.name} Uptime`,
              value: details.uptime,
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
    
    // Extract resource info based on platform
    if (checkResult.resources) {
      if (isPlatformResources(checkResult.resources, 'process')) {
        if (checkResult.resources.data.pid) {
          parts.push(`PID: ${checkResult.resources.data.pid}`);
        }
        if (checkResult.resources.data.port) {
          parts.push(`Port: ${checkResult.resources.data.port}`);
        }
      } else if (isPlatformResources(checkResult.resources, 'container')) {
        if (checkResult.resources.data.containerId) {
          parts.push(`Container: ${checkResult.resources.data.containerId.slice(0, 12)}`);
        }
        // Container ports are stored differently
        const ports = checkResult.resources.data.ports;
        if (ports) {
          const firstPort = Object.keys(ports)[0];
          if (firstPort) {
            parts.push(`Port: ${firstPort}`);
          }
        }
      } else if (isPlatformResources(checkResult.resources, 'aws')) {
        if (checkResult.resources.data.instanceId) {
          parts.push(`Instance: ${checkResult.resources.data.instanceId}`);
        } else if (checkResult.resources.data.taskArn) {
          const taskId = checkResult.resources.data.taskArn.split('/').pop()?.slice(0, 12);
          parts.push(`Task: ${taskId}`);
        }
      }
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
export type { ServiceStatus, LogEntry, MetricData } from '../dashboard/dashboard-components.js';