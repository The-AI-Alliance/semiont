import { Service, ServiceName, DeploymentType, Config, StartResult, ServiceConfig } from './types.js';
import { printInfo, printSuccess, printWarning, printError } from '../lib/cli-logger.js';

export abstract class BaseService implements Service {
  protected config: Config;
  protected serviceConfig: ServiceConfig;
  protected envVars: Record<string, string> = {};
  
  constructor(
    public readonly name: ServiceName,
    public readonly deployment: DeploymentType,
    config: Config,
    serviceConfig: ServiceConfig
  ) {
    this.config = config;
    this.serviceConfig = serviceConfig;
    this.envVars = { ...process.env };
  }
  
  async start(): Promise<StartResult> {
    const startTime = new Date();
    
    try {
      if (this.config.dryRun) {
        if (!this.config.quiet) {
          printInfo(`[DRY RUN] Would start ${this.name} (${this.deployment})`);
        }
        return {
          service: this.name,
          deployment: this.deployment,
          success: true,
          startTime,
          metadata: { dryRun: true }
        };
      }
      
      if (!this.config.quiet) {
        printInfo(`Starting ${this.name} (${this.deployment})...`);
      }
      
      // Pre-start hook for service-specific setup
      await this.preStart();
      
      // Deployment-specific start logic
      const result = await this.doStart();
      
      // Post-start hook for service-specific validation
      await this.postStart();
      
      if (!this.config.quiet) {
        printSuccess(`${this.name} started successfully`);
      }
      
      return {
        ...result,
        success: true,
        startTime
      };
      
    } catch (error) {
      if (!this.config.quiet) {
        printError(`Failed to start ${this.name}: ${error}`);
      }
      
      return {
        service: this.name,
        deployment: this.deployment,
        success: false,
        startTime,
        error: (error as Error).message
      };
    }
  }
  
  // Hooks for service-specific logic
  protected async preStart(): Promise<void> {
    // Override in subclasses for service-specific setup
  }
  
  protected async postStart(): Promise<void> {
    // Override in subclasses for service-specific validation
  }
  
  // Abstract method for deployment-specific start implementation
  protected abstract doStart(): Promise<StartResult>;
  
  // Helper methods for environment variables
  protected getEnvVar(key: string): string | undefined {
    return this.envVars[key];
  }
  
  protected setEnvVar(key: string, value: string): void {
    this.envVars[key] = value;
  }
}