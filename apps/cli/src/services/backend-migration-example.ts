// BEFORE: Current implementation (lines 319-603 of start.ts condensed)
// All deployment types mixed in one giant switch statement

async function startProcessService_OLD(serviceInfo: ServiceDeploymentInfo) {
  switch (serviceInfo.name) {
    case 'backend':
      if (serviceInfo.deploymentType === 'process') {
        // 100 lines of process-specific backend logic
        spawn('npm', ['run', 'dev'], { cwd, env });
      } else if (serviceInfo.deploymentType === 'container') {
        // 50 lines of container-specific backend logic  
        await runContainer('semiont-backend', { ports });
      } else if (serviceInfo.deploymentType === 'aws') {
        // 40 lines of AWS-specific backend logic
        execSync('aws ecs update-service');
      }
      break;
    case 'frontend':
      // Another 200 lines...
      break;
  }
}

// =================================================================
// AFTER: New Service-oriented architecture
// =================================================================

import { BaseService } from './base-service.js';
import { ServiceName, DeploymentType, Config } from './types.js';
import { spawn } from 'child_process';
import * as path from 'path';
import { loadEnvironmentConfig, getNodeEnvForEnvironment } from '../lib/deployment-resolver.js';

export class BackendService extends BaseService {
  constructor(deployment: DeploymentType, config: Config) {
    super('backend', deployment, config);
  }
  
  // Service-specific logic that ALL deployment types need
  protected async preStart(): Promise<void> {
    // Backend always needs database config
    await this.ensureDatabaseConfig();
    
    // Backend always needs JWT secret
    if (!this.getEnvVar('JWT_SECRET')) {
      this.setEnvVar('JWT_SECRET', 'local-dev-secret');
    }
  }
  
  protected async postStart(): Promise<void> {
    // Backend-specific: wait for health check
    console.log('Waiting for backend to be healthy...');
    let attempts = 0;
    while (attempts < 30) {
      const status = await this.check();
      if (status.healthy) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }
    throw new Error('Backend failed to become healthy');
  }
  
  // Backend-specific environment setup
  private async ensureDatabaseConfig(): Promise<void> {
    const dbUrl = this.getEnvVar('DATABASE_URL');
    if (!dbUrl) {
      // Each deployment strategy knows how to find its database
      const defaultUrl = await this.strategy.getDatabaseUrl();
      this.setEnvVar('DATABASE_URL', defaultUrl);
    }
  }
  
  // Backend owns its own special commands
  async update(): Promise<void> {
    console.log('Running backend migrations...');
    await this.strategy.runCommand(['npm', 'run', 'db:migrate']);
  }
  
  async backup(): Promise<void> {
    console.log('Backing up database...');
    const dbUrl = this.getEnvVar('DATABASE_URL');
    await this.strategy.backupDatabase(dbUrl);
  }
  
  async restore(backupId: string): Promise<void> {
    console.log(`Restoring database from ${backupId}...`);
    const dbUrl = this.getEnvVar('DATABASE_URL');
    await this.strategy.restoreDatabase(dbUrl, backupId);
  }
  
  async publish(): Promise<void> {
    console.log('Publishing OpenAPI spec...');
    // Backend publishes its API spec
    await this.strategy.runCommand(['npm', 'run', 'openapi:generate']);
    await this.strategy.uploadFile('openapi.json', 's3://api-specs/backend.json');
  }
}

// =================================================================
// Deployment strategies handle HOW, not WHAT
// =================================================================

class ProcessDeploymentStrategy implements DeploymentStrategy {
  async start(service: ServiceName, config: Config): Promise<void> {
    const serviceDir = path.join(config.projectRoot, 'apps', service);
    const proc = spawn('npm', ['run', 'dev'], {
      cwd: serviceDir,
      stdio: 'pipe',
      detached: true,
      env: config.environment // Service has already set up env vars
    });
    proc.unref();
  }
  
  async getDatabaseUrl(): Promise<string> {
    // Process deployment assumes local postgres
    return 'postgresql://postgres:localpassword@localhost:5432/semiont';
  }
  
  async runCommand(command: string[]): Promise<void> {
    const { execSync } = await import('child_process');
    execSync(command.join(' '), { 
      cwd: path.join(this.config.projectRoot, 'apps', this.serviceName)
    });
  }
  
  async backupDatabase(dbUrl: string): Promise<void> {
    const { execSync } = await import('child_process');
    const timestamp = new Date().toISOString();
    execSync(`pg_dump ${dbUrl} > backup-${timestamp}.sql`);
  }
}

class ContainerDeploymentStrategy implements DeploymentStrategy {
  async start(service: ServiceName, config: Config): Promise<void> {
    await runContainer(`semiont-${service}`, {
      ports: { '3001': '3001' },
      environment: config.environment,
      detached: true
    });
  }
  
  async getDatabaseUrl(): Promise<string> {
    // Container deployment uses containerized postgres
    return 'postgresql://postgres:localpassword@semiont-postgres:5432/semiont';
  }
  
  async runCommand(command: string[]): Promise<void> {
    const { execSync } = await import('child_process');
    execSync(`docker exec semiont-${this.serviceName} ${command.join(' ')}`);
  }
  
  async backupDatabase(dbUrl: string): Promise<void> {
    const { execSync } = await import('child_process');
    const timestamp = new Date().toISOString();
    execSync(`docker exec semiont-postgres pg_dump semiont > backup-${timestamp}.sql`);
  }
}

class AWSDeploymentStrategy implements DeploymentStrategy {
  async start(service: ServiceName, config: Config): Promise<void> {
    const { execSync } = await import('child_process');
    execSync(`aws ecs update-service --service ${service}-${config.environment} --desired-count 1`);
  }
  
  async getDatabaseUrl(): Promise<string> {
    // AWS deployment reads from RDS endpoint
    const { execSync } = await import('child_process');
    const endpoint = execSync('aws rds describe-db-instances --query ...').toString().trim();
    return `postgresql://admin:${process.env.DB_PASSWORD}@${endpoint}/semiont`;
  }
  
  async runCommand(command: string[]): Promise<void> {
    // AWS runs commands via ECS task
    const { execSync } = await import('child_process');
    execSync(`aws ecs run-task --task-definition migration-task --overrides '{"command": ${JSON.stringify(command)}}'`);
  }
  
  async backupDatabase(dbUrl: string): Promise<void> {
    // AWS uses RDS snapshots
    const { execSync } = await import('child_process');
    const timestamp = new Date().toISOString();
    execSync(`aws rds create-db-snapshot --db-instance-identifier semiont --db-snapshot-identifier backup-${timestamp}`);
  }
}

// =================================================================
// Usage: The new start.ts becomes trivial
// =================================================================

export async function start(serviceName: ServiceName, options: any): Promise<void> {
  const config: Config = {
    projectRoot: process.env.SEMIONT_ROOT || process.cwd(),
    environment: options.environment || 'dev',
    verbose: options.verbose
  };
  
  const deployment = options.deployment || 'process';
  
  // This replaces 800 lines of switch statements
  const service = ServiceFactory.create(serviceName, deployment, config);
  await service.start();
}