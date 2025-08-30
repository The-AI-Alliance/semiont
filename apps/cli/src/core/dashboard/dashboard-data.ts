/**
 * Dashboard Data Source - New Service Architecture
 * 
 * Provides real-time data collection using the Platform Strategy pattern
 */

import { ServiceFactory } from '../../services/service-factory.js';
import { ServiceName } from '../services.js';
import { CheckResult } from '../commands/check.js';
import { ServiceConfig } from '../cli-config.js';
import { type ServicePlatformInfo, Platform } from '../platform-resolver.js';
import { Config } from '../cli-config.js';
import { isPlatformResources } from '../../platforms/platform-resources.js';

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
        const { PlatformFactory } = await import('../../platforms/index.js');
        const platform = PlatformFactory.getPlatform(deployment.platform);
        const checkResult: CheckResult = await platform.check(service);
        
        // Convert to dashboard format with all new fields
        const serviceStatus: ServiceStatus = {
          name: deployment.name.charAt(0).toUpperCase() + deployment.name.slice(1),
          status: this.mapStatus(checkResult.status),
          details: this.getDetails(checkResult),
          lastUpdated: new Date()
        };
        
        // Add ECS-specific details from health
        if (checkResult.health?.details) {
          const details = checkResult.health.details;
          serviceStatus.revision = details.revision;
          serviceStatus.desiredCount = details.desiredCount;
          serviceStatus.runningCount = details.runningCount;
          serviceStatus.pendingCount = details.pendingCount;
          serviceStatus.taskDefinition = details.taskDefinition;
          serviceStatus.deploymentStatus = details.deploymentStatus;
          
          // Add EFS storage metrics
          if (details.storageUsedBytes !== undefined) {
            serviceStatus.storageUsedBytes = details.storageUsedBytes;
            serviceStatus.storageUsedStandard = details.storageUsedStandard;
            serviceStatus.storageUsedIA = details.storageUsedIA;
            // EFS doesn't have a hard limit, but we can show usage
            serviceStatus.storageTotalBytes = details.storageUsedBytes * 10; // Show as 10% used for UI
            serviceStatus.storageAvailableBytes = serviceStatus.storageTotalBytes - details.storageUsedBytes;
            serviceStatus.storageUsedPercent = 10; // Always show as 10% for EFS since it's elastic
            serviceStatus.throughputUtilization = details.provisionedThroughputInMibps ? 50 : 0; // Estimate
            serviceStatus.clientConnections = details.numberOfMountTargets || 0;
          }
        }
        
        // Add AWS identifiers from metadata for console links
        if (checkResult.metadata) {
          serviceStatus.awsRegion = checkResult.metadata.awsRegion;
          serviceStatus.ecsServiceName = checkResult.metadata.ecsServiceName;
          serviceStatus.ecsClusterName = checkResult.metadata.ecsClusterName;
          serviceStatus.rdsInstanceId = checkResult.metadata.rdsInstanceId;
          serviceStatus.efsFileSystemId = checkResult.metadata.efsFileSystemId;
          serviceStatus.cloudFormationStackName = checkResult.metadata.cloudFormationStackName;
          serviceStatus.logGroupName = checkResult.metadata.logGroupName;
          serviceStatus.cluster = checkResult.metadata.ecsClusterName;
          
          // Add ALB and WAF information
          if (checkResult.metadata.loadBalancerDns) {
            serviceStatus.loadBalancerDns = checkResult.metadata.loadBalancerDns;
          }
          if (checkResult.metadata.albArn) {
            serviceStatus.albArn = checkResult.metadata.albArn;
          }
          if (checkResult.metadata.wafWebAclId) {
            serviceStatus.wafWebAclId = checkResult.metadata.wafWebAclId;
          }
        }
        
        // Add from resources if available
        if (checkResult.resources && isPlatformResources(checkResult.resources, 'aws')) {
          const awsData = checkResult.resources.data;
          serviceStatus.albArn = awsData.albArn;
          // Image URI would come from task definition - not available yet
        }
        
        services.push(serviceStatus);

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
      if (isPlatformResources(checkResult.resources, 'posix')) {
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