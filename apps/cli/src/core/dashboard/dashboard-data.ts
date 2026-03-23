/**
 * Dashboard Data Source - New Service Architecture
 * 
 * Provides real-time data collection using the Platform Strategy pattern
 */

import * as fs from 'fs';
import * as http from 'http';
import { check } from '../commands/check.js';
import { CommandResult } from '../command-result.js';
import { type ServicePlatformInfo } from '../service-resolver.js';
import { isPlatformResources } from '../../platforms/platform-resources.js';
import { SemiontProject } from '@semiont/core/node';

import type {
  ServiceStatus, LogEntry, MetricData,
  MakeMeaningStatus, WorkerStatus
} from '../dashboard/dashboard-components.js';


export interface DashboardData {
  services: ServiceStatus[];
  logs: LogEntry[];
  metrics: MetricData[];
  lastUpdate: Date;
  isRefreshing: boolean;
  makeMeaning: MakeMeaningStatus;
  workers: WorkerStatus[];
}

export class DashboardDataSource {
  constructor(
    private environment: string,
    private serviceDeployments?: ServicePlatformInfo[],
    private envConfig?: import('@semiont/core').EnvironmentConfig
  ) {}

  /**
   * Get dashboard data using the new service architecture
   */
  async getDashboardData(): Promise<DashboardData> {
    // If no service deployments provided, return empty data
    if (!this.serviceDeployments || !this.envConfig) {
      return {
        services: [],
        logs: [],
        metrics: [],
        lastUpdate: new Date(),
        isRefreshing: false,
        makeMeaning: this.emptyMakeMeaningStatus(),
        workers: []
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
            forceDiscovery: false,
            preflight: false
          },
          this.envConfig
        );
        
        // Extract the first (and only) result from the aggregated results
        const checkResult = checkResults.results?.[0];
        
        if (!checkResult) {
          // No result returned - service check failed
          services.push({
            name: deployment.name,
            status: 'unknown',
            details: 'Check failed - no result',
            lastUpdated: new Date()
          });
          continue;
        }
        
        // Convert to dashboard format with all new fields
        const checkedAt = new Date();
        const serviceStatus: ServiceStatus = {
          name: deployment.name,
          status: this.mapStatus(checkResult.extensions?.status || 'unknown'),
          details: checkResult.error || this.getDetails(checkResult),
          evidence: this.getEvidence(checkResult),
          checkedAt,
          lastUpdated: checkedAt,
          hostname: this.getHostname(deployment.name),
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
      isRefreshing: false,
      makeMeaning: await this.getMakeMeaningStatus(),
      workers: await this.getWorkerStatus()
    };
  }

  private emptyMakeMeaningStatus(): MakeMeaningStatus {
    const unknown = { state: 'unknown' as const };
    return {
      eventLog: { path: '' },
      contentStore: { path: '' },
      graph: { status: 'unknown' },
      materializedViews: { path: '' },
      actors: { gatherer: unknown, matcher: unknown, stower: unknown }
    };
  }

  async getMakeMeaningStatus(): Promise<MakeMeaningStatus> {
    const result = this.emptyMakeMeaningStatus();

    // File-stat based sources — work without backend running
    try {
      const project = new SemiontProject(process.cwd());

      // Event log
      result.eventLog.path = project.eventsDir;
      if (fs.existsSync(project.eventsDir)) {
        const entries = fs.readdirSync(project.eventsDir);
        result.eventLog.streamCount = entries.length;
        let totalBytes = 0;
        let eventCount = 0;
        for (const entry of entries) {
          try {
            const stat = fs.statSync(`${project.eventsDir}/${entry}`);
            totalBytes += stat.size;
            // Rough event count: each line ~100 bytes
            eventCount += Math.floor(stat.size / 100);
          } catch { /* skip */ }
        }
        result.eventLog.sizeBytes = totalBytes;
        result.eventLog.eventCount = eventCount;
      }

      // Content store — recursive scan
      result.contentStore.path = project.dataHome;
      if (fs.existsSync(project.dataHome)) {
        const { fileCount, sizeBytes } = this.dirStats(project.dataHome);
        result.contentStore.fileCount = fileCount;
        result.contentStore.sizeBytes = sizeBytes;
      }

      // Materialized views
      result.materializedViews.path = project.projectionsDir;
      if (fs.existsSync(project.projectionsDir)) {
        const entries = fs.readdirSync(project.projectionsDir);
        result.materializedViews.fileCount = entries.length;
        let lastUpdated: Date | undefined;
        for (const entry of entries) {
          try {
            const stat = fs.statSync(`${project.projectionsDir}/${entry}`);
            if (!lastUpdated || stat.mtime > lastUpdated) lastUpdated = stat.mtime;
          } catch { /* skip */ }
        }
        result.materializedViews.lastUpdated = lastUpdated;
      }
    } catch { /* not a semiont project dir */ }

    // Graph: re-use status from services[] if graph service was checked
    // (set by caller via getDashboardData — actors below are from backend API)

    // Enrich actors with model/provider from envConfig (static config, always available)
    for (const name of ['gatherer', 'matcher', 'stower'] as const) {
      const actorCfg = (this.envConfig?.actors as any)?.[name];
      const inferCfg = actorCfg?.inference;
      if (inferCfg?.model) result.actors[name].model = inferCfg.model;
      if (inferCfg?.type) result.actors[name].provider = inferCfg.type;
      else if (!inferCfg?.type && this.envConfig?.inference) {
        // Infer provider from top-level inference config
        const inf = this.envConfig.inference as any;
        if (inf?.ollama) result.actors[name].provider = 'ollama';
        else if (inf?.anthropic) result.actors[name].provider = 'anthropic';
      }
    }

    // Actor runtime status from backend health API
    const backendPort = this.envConfig
      ? (this.envConfig as any)?.services?.backend?.port ?? 4000
      : 4000;
    try {
      const health = await this.fetchBackendHealth(backendPort);
      if (health?.actors) {
        // Merge runtime state into existing (preserving model/provider already set)
        for (const name of ['gatherer', 'matcher', 'stower'] as const) {
          if (health.actors[name]) {
            result.actors[name] = { ...result.actors[name], ...health.actors[name] };
          }
        }
      }
    } catch { /* backend not running — leave as unknown */ }

    return result;
  }

  async getWorkerStatus(): Promise<WorkerStatus[]> {
    const types: WorkerStatus['type'][] = [
      'reference-annotation', 'highlight-annotation', 'assessment-annotation',
      'comment-annotation', 'tag-annotation', 'generation'
    ];

    const backendPort = this.envConfig
      ? (this.envConfig as any)?.services?.backend?.port ?? 4000
      : 4000;

    try {
      const health = await this.fetchBackendHealth(backendPort);
      if (health?.workers && Array.isArray(health.workers)) {
        return health.workers as WorkerStatus[];
      }
    } catch { /* backend not running */ }

    // Default: all idle with zero counts
    return types.map(type => ({
      type,
      state: 'idle' as const,
      pendingCount: 0,
      activeCount: 0
    }));
  }

  private fetchBackendHealth(port: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://localhost:${port}/api/health`, { timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  private getHostname(serviceName: string): string | undefined {
    if (!this.envConfig) return undefined;
    const svc = (this.envConfig.services as any)?.[serviceName];
    if (svc?.port) return `localhost:${svc.port}`;
    if (svc?.publicURL) return svc.publicURL;
    return undefined;
  }

  private dirStats(dir: string): { fileCount: number; sizeBytes: number } {
    let fileCount = 0;
    let sizeBytes = 0;
    const walk = (d: string) => {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = `${d}/${entry.name}`;
          if (entry.isDirectory()) { walk(full); }
          else if (entry.isFile()) { fileCount++; sizeBytes += fs.statSync(full).size; }
        }
      } catch { /* skip */ }
    };
    walk(dir);
    return { fileCount, sizeBytes };
  }

  private mapStatus(status?: 'running' | 'stopped' | 'unknown' | string): 'healthy' | 'warning' | 'unhealthy' | 'unknown' {
    switch (status) {
      case 'running': return 'healthy';
      case 'stopped': return 'unhealthy';
      case 'unknown': return 'warning';  // Show as warning instead of unknown
      default: return 'warning';
    }
  }

  private getEvidence(checkResult: CommandResult): string[] {
    const ev: string[] = [];
    const d = checkResult.extensions?.health?.details as any;
    const meta = checkResult.metadata as any;

    if (!d && !meta) return ev;

    // Inference evidence (Anthropic or Ollama)
    if (meta?.serviceType === 'inference') {
      if (d?.endpoint)      ev.push(d.endpoint);
      if (d?.model)         ev.push(d.model);
      if (d?.responseTime)  ev.push(d.responseTime);
      if (d?.responsePreview) ev.push(`"${String(d.responsePreview).slice(0, 20)}"`);
      // Ollama: show model availability
      if (d?.modelAvailability) {
        for (const [m, avail] of Object.entries(d.modelAvailability as Record<string, boolean>)) {
          ev.push(`${m} ${avail ? '✓' : '✗'}`);
        }
      }
      return ev;
    }

    // Generic connection/protocol evidence (works for neo4j bolt, gremlin ws, etc.)
    if (d?.address)          ev.push(`connected ${d.address}`);
    if (d?.protocolVersion)  ev.push(`protocol v${d.protocolVersion}`);
    if (meta?.agent)         ev.push(String(meta.agent).slice(0, 40));

    // HTTP evidence — explicit endpoint with status code
    if (d?.endpoint) {
      const code = d.statusCode ?? d.status;
      ev.push(code ? `GET ${d.endpoint} → ${code}` : `GET ${d.endpoint}`);
    }
    // HTTP evidence — status code without explicit endpoint (posix frontend)
    if (d?.statusCode && !d?.endpoint && !d?.address) {
      const port = d.port ?? meta?.port;
      ev.push(`GET localhost:${port} → ${d.statusCode}`);
    }
    // HTTP evidence — health object without endpoint (posix backend API client)
    if (d?.health && !d?.endpoint && !d?.address) {
      const port = d.port ?? meta?.port;
      ev.push(`GET localhost:${port}/api/health → 200`);
    }

    // Process evidence
    if (d?.pid) ev.push(`pid ${d.pid}`);
    if (d?.process?.memory) ev.push(`mem ${d.process.memory}`);

    // Container evidence (from resources or proxy metadata)
    const resources = checkResult.extensions?.resources;
    const containerResourceId = resources && isPlatformResources(resources, 'container')
      ? resources.data.containerId : undefined;
    const containerId = meta?.healthCheck?.containerId ?? containerResourceId;
    if (containerId) ev.push(`container ${String(containerId).slice(0, 12)}`);
    if (meta?.healthCheck?.uptime) ev.push(String(meta.healthCheck.uptime));

    // Proxy routing evidence
    if (meta?.healthCheck) {
      const hc = meta.healthCheck;
      if (hc.frontendRouting !== undefined) ev.push(`fe route ${hc.frontendRouting ? '✓' : '✗'}`);
      if (hc.backendRouting  !== undefined) ev.push(`be route ${hc.backendRouting  ? '✓' : '✗'}`);
      if (hc.adminHealthy    !== undefined) ev.push(`admin ${hc.adminHealthy ? '✓' : '✗'}`);
    }

    // AWS task evidence
    if (meta?.taskArn) ev.push(`task ${String(meta.taskArn).split('/').pop()?.slice(0, 8)}`);

    return ev;
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
    
    // Fallback: proxy check puts containerId in metadata.healthCheck, not in resources
    if (parts.length === 0) {
      const containerId = (checkResult.metadata as any)?.healthCheck?.containerId;
      if (containerId) parts.push(`Container: ${String(containerId).slice(0, 12)}`);
    }

    return parts.join(', ') || checkResult.extensions?.status || 'unknown';
  }

  private detectLogLevel(log: string): 'info' | 'warn' | 'error' {
    if (log.match(/\b(error|ERROR|Error)\b/)) return 'error';
    if (log.match(/\b(warning|WARNING|Warning|warn|WARN)\b/)) return 'warn';
    return 'info';
  }
}

// Re-export types for convenience
export type { ServiceStatus, LogEntry, MetricData, MakeMeaningStatus, WorkerStatus, ActorStatus } from '../dashboard/dashboard-components.js';