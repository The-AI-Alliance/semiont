/**
 * Dashboard shared types
 */

export interface ServiceStatus {
  name: string;
  status: 'healthy' | 'unhealthy' | 'warning' | 'unknown';
  details?: string;
  lastUpdated?: Date;
  // ECS-specific details
  revision?: number;
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
  taskDefinition?: string;
  cluster?: string;
  deploymentStatus?: string;
  imageUri?: string;
  // Service metrics
  cpuUtilization?: number;
  memoryUtilization?: number;
  requestCount?: number;
  errorRate?: number;
  // EFS-specific details
  storageUsedBytes?: number;
  storageAvailableBytes?: number;
  storageTotalBytes?: number;
  storageUsedPercent?: number;
  storageUsedStandard?: number;
  storageUsedIA?: number;
  throughputUtilization?: number;
  clientConnections?: number;
  // AWS Console links data
  awsRegion?: string;
  ecsServiceName?: string;
  ecsClusterName?: string;
  rdsInstanceId?: string;
  efsFileSystemId?: string;
  albArn?: string;
  loadBalancerDns?: string;
  wafWebAclId?: string;
  route53ZoneId?: string;
  cloudFormationStackName?: string;
  logGroupName?: string;
}

export interface LogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug';
  service: string;
  message: string;
}

export interface MetricData {
  name: string;
  value: number;
  unit?: string;
  trend?: 'up' | 'down' | 'stable';
}

export interface ActorStatus {
  state: 'idle' | 'active' | 'error' | 'unknown';
  model?: string;
  lastActivity?: Date;
  errorMessage?: string;
}

export interface MakeMeaningStatus {
  eventLog: { path: string; eventCount?: number; streamCount?: number; sizeBytes?: number };
  contentStore: { path: string; fileCount?: number; sizeBytes?: number };
  graph: { status: 'healthy' | 'unhealthy' | 'unknown'; address?: string; database?: string };
  materializedViews: { path: string; fileCount?: number; lastUpdated?: Date };
  actors: {
    gatherer: ActorStatus;
    matcher: ActorStatus;
    stower: ActorStatus;
  };
}

export interface WorkerStatus {
  type: 'reference-annotation' | 'highlight-annotation' | 'assessment-annotation' |
        'comment-annotation' | 'tag-annotation' | 'generation';
  state: 'idle' | 'active' | 'error';
  pendingCount: number;
  activeCount: number;
  lastProcessed?: Date;
}
