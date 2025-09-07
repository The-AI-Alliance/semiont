/**
 * Dashboard Data Source - New Service Architecture
 * 
 * Provides real-time data collection using the Platform Strategy pattern
 */

import { check } from '../commands/check.js';
import { CommandResult } from '../command-result.js';
import { type ServicePlatformInfo } from '../service-resolver.js';
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
        // Use UnifiedExecutor through the check command
        const checkResults = await check(
          [deployment],  // Pass single deployment as array
          {
            environment: this.environment,
            service: deployment.name,
            all: false,
            deep: true,
            wait: false,
            verbose: false,
            quiet: true,
            dryRun: false,
            output: 'json',
            forceDiscovery: false
          }
        );
        
        // Extract the first (and only) result from the aggregated results
        const checkResult = checkResults.results?.[0];
        
        if (!checkResult) {
          // No result returned - service check failed
          services.push({
            name: deployment.name.charAt(0).toUpperCase() + deployment.name.slice(1),
            status: 'unknown',
            details: 'Check failed - no result',
            lastUpdated: new Date()
          });
          continue;
        }
        
        // Convert to dashboard format with all new fields
        const serviceStatus: ServiceStatus = {
          name: deployment.name.charAt(0).toUpperCase() + deployment.name.slice(1),
          status: this.mapStatus(checkResult.extensions?.status || 'unknown'),
          details: checkResult.error || this.getDetails(checkResult),
          lastUpdated: new Date()
        };
        
        // Add ECS-specific details from health
        if (checkResult.extensions?.health?.details) {
          const details = checkResult.extensions.health.details;
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
        if (checkResult.extensions?.resources && isPlatformResources(checkResult.extensions.resources, 'aws')) {
          const awsData = checkResult.extensions.resources.data;
          serviceStatus.albArn = awsData.albArn;
          // Image URI would come from task definition - not available yet
        }
        
        services.push(serviceStatus);

        // Add logs if available
        if (checkResult.extensions?.logs?.recent) {
          checkResult.extensions.logs.recent.forEach(log => {
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
        if (checkResult.extensions?.health?.details) {
          const details = checkResult.extensions.health.details;
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

  private mapStatus(status?: 'running' | 'stopped' | 'unknown' | string): 'healthy' | 'warning' | 'unhealthy' | 'unknown' {
    switch (status) {
      case 'running': return 'healthy';
      case 'stopped': return 'unhealthy';
      case 'unknown': return 'warning';  // Show as warning instead of unknown
      default: return 'warning';
    }
  }

  private getDetails(checkResult: CommandResult): string {
    const parts = [];
    
    if (checkResult.extensions?.health?.healthy) {
      parts.push('Healthy');
    }
    
    // Extract resource info based on platform
    if (checkResult.extensions?.resources) {
      if (isPlatformResources(checkResult.extensions.resources, 'posix')) {
        if (checkResult.extensions.resources.data.pid) {
          parts.push(`PID: ${checkResult.extensions.resources.data.pid}`);
        }
        if (checkResult.extensions.resources.data.port) {
          parts.push(`Port: ${checkResult.extensions.resources.data.port}`);
        }
      } else if (isPlatformResources(checkResult.extensions.resources, 'container')) {
        if (checkResult.extensions.resources.data.containerId) {
          parts.push(`Container: ${checkResult.extensions.resources.data.containerId.slice(0, 12)}`);
        }
        // Container ports are stored differently
        const ports = checkResult.extensions.resources.data.ports;
        if (ports) {
          const firstPort = Object.keys(ports)[0];
          if (firstPort) {
            parts.push(`Port: ${firstPort}`);
          }
        }
      } else if (isPlatformResources(checkResult.extensions.resources, 'aws')) {
        if (checkResult.extensions.resources.data.instanceId) {
          parts.push(`Instance: ${checkResult.extensions.resources.data.instanceId}`);
        } else if (checkResult.extensions.resources.data.taskArn) {
          const taskId = checkResult.extensions.resources.data.taskArn.split('/').pop()?.slice(0, 12);
          parts.push(`Task: ${taskId}`);
        }
      }
    }
    
    return parts.join(', ') || checkResult.extensions?.status || 'unknown';
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