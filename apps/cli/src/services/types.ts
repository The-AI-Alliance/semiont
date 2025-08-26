// Service architecture types

export type ServiceName = 'backend' | 'frontend' | 'database' | 'filesystem' | 'mcp' | 'agent';
export type DeploymentType = 'aws' | 'container' | 'process' | 'external';
export type Environment = 'dev' | 'staging' | 'prod' | 'ci' | 'local';

export interface Config {
  projectRoot: string;
  environment: Environment;
  verbose: boolean;
  quiet: boolean;
  dryRun?: boolean;
}

export interface ServiceConfig {
  deploymentType: DeploymentType;
  port?: number;
  command?: string;
  image?: string;
  host?: string;
  path?: string;
  name?: string;
  user?: string;
  password?: string;
  [key: string]: any;
}

export interface StartResult {
  service: ServiceName;
  deployment: DeploymentType;
  success: boolean;
  startTime: Date;
  endpoint?: string;
  pid?: number;
  containerId?: string;
  error?: string;
  metadata?: Record<string, any>;
}

// Service interface - will grow with each migration phase
export interface Service {
  readonly name: ServiceName;
  readonly deployment: DeploymentType;
  
  start(): Promise<StartResult>;
  // Future methods:
  // stop(): Promise<void>;
  // check(): Promise<HealthStatus>;
  // logs(tail?: boolean, lines?: number): Promise<void>;
  // update(): Promise<void>;
  // backup(): Promise<void>;
  // restore(backupId: string): Promise<void>;
  // publish(): Promise<void>;
}