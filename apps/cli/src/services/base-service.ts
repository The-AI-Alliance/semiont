/**
 * Base Service Implementation - Refactored with Platform Strategy
 * 
 * This base class now delegates all platform-specific operations to
 * PlatformStrategy instances, dramatically simplifying service implementations.
 */

import { Service, ServiceName, DeploymentType, Config, StartResult, StopResult, CheckResult, UpdateResult, ProvisionResult, PublishResult, BackupResult, ExecResult, ExecOptions, TestResult, TestOptions, RestoreResult, RestoreOptions, ServiceConfig } from './types.js';
import { printInfo, printSuccess, printWarning, printError } from '../lib/cli-logger.js';
import { StateManager, ServiceState } from './state-manager.js';
import { PlatformFactory, PlatformStrategy, ServiceContext } from '../platforms/index.js';

export abstract class BaseService implements Service, ServiceContext {
  protected readonly systemConfig: Config;
  public readonly config: ServiceConfig;
  protected envVars: Record<string, string | undefined> = {};
  private platform: PlatformStrategy;
  
  constructor(
    public readonly name: ServiceName,
    public readonly deployment: DeploymentType,
    systemConfig: Config,
    serviceConfig: ServiceConfig
  ) {
    this.systemConfig = systemConfig;
    this.config = serviceConfig;
    this.envVars = { ...process.env } as Record<string, string | undefined>;
    this.platform = PlatformFactory.getPlatform(deployment);
  }
  
  // =====================================================================
  // Service Context Implementation
  // These methods provide service-specific information to the platform
  // =====================================================================
  
  get environment() { return this.systemConfig.environment; }
  get projectRoot() { return this.systemConfig.projectRoot; }
  get verbose() { return this.systemConfig.verbose || false; }
  get quiet() { return this.systemConfig.quiet || false; }
  get dryRun() { return this.systemConfig.dryRun || false; }
  
  /**
   * Get the port for this service
   * Override in service implementations
   */
  getPort(): number {
    return this.config.port || 3000;
  }
  
  /**
   * Get the health check endpoint
   * Override in service implementations
   */
  getHealthEndpoint(): string {
    return '/health';
  }
  
  /**
   * Get the command to run for process deployment
   * Override in service implementations
   */
  getCommand(): string {
    return this.config.command || 'npm start';
  }
  
  /**
   * Get the container image
   * Override in service implementations
   */
  getImage(): string {
    return this.config.image || `semiont/${this.name}:latest`;
  }
  
  /**
   * Get environment variables for the service
   * Override to add service-specific variables
   */
  getEnvironmentVariables(): Record<string, string> {
    const envVars: Record<string, string> = {};
    
    // Only add defined environment variables
    for (const [key, value] of Object.entries(this.envVars)) {
      if (value !== undefined) {
        envVars[key] = value;
      }
    }
    
    return {
      NODE_ENV: this.systemConfig.environment,
      ...envVars
    };
  }
  
  // =====================================================================
  // Service Interface Implementation
  // All operations now delegate to the platform strategy
  // =====================================================================
  
  async start(): Promise<StartResult> {
    const startTime = new Date();
    
    try {
      if (this.systemConfig.dryRun) {
        if (!this.systemConfig.quiet) {
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
      
      if (!this.systemConfig.quiet) {
        printInfo(`Starting ${this.name} (${this.deployment})...`);
      }
      
      // Pre-start hook for service-specific setup
      await this.preStart();
      
      // Delegate to platform strategy
      const result = await this.platform.start(this);
      
      // Post-start hook for service-specific validation
      await this.postStart();
      
      // Save state for later operations
      await this.saveState(result);
      
      if (!this.systemConfig.quiet) {
        printSuccess(`${this.name} started successfully`);
      }
      
      return {
        ...result,
        success: true,
        startTime
      };
      
    } catch (error) {
      if (!this.systemConfig.quiet) {
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
  
  async stop(): Promise<StopResult> {
    const stopTime = new Date();
    
    try {
      if (this.systemConfig.dryRun) {
        if (!this.systemConfig.quiet) {
          printInfo(`[DRY RUN] Would stop ${this.name} (${this.deployment})`);
        }
        return {
          service: this.name,
          deployment: this.deployment,
          success: true,
          stopTime,
          metadata: { dryRun: true }
        };
      }
      
      if (!this.systemConfig.quiet) {
        printInfo(`Stopping ${this.name} (${this.deployment})...`);
      }
      
      // Pre-stop hook for service-specific cleanup
      await this.preStop();
      
      // Delegate to platform strategy
      const result = await this.platform.stop(this);
      
      // Post-stop hook for service-specific validation
      await this.postStop();
      
      // Clear saved state after successful stop
      await StateManager.clear(this.systemConfig.projectRoot, this.systemConfig.environment, this.name);
      
      if (!this.systemConfig.quiet) {
        printSuccess(`${this.name} stopped successfully`);
      }
      
      return {
        ...result,
        success: true,
        stopTime
      };
      
    } catch (error) {
      if (!this.systemConfig.quiet) {
        printError(`Failed to stop ${this.name}: ${error}`);
      }
      
      return {
        service: this.name,
        deployment: this.deployment,
        success: false,
        stopTime,
        error: (error as Error).message
      };
    }
  }
  
  async check(): Promise<CheckResult> {
    const checkTime = new Date();
    
    try {
      if (!this.systemConfig.quiet) {
        printInfo(`Checking ${this.name} (${this.deployment})...`);
      }
      
      // Load saved state to verify
      const savedState = await this.loadState();
      
      // Delegate to platform strategy
      const result = await this.platform.check(this);
      
      // Verify state matches reality
      if (savedState && result.status === 'running') {
        result.stateVerified = await this.verifyState(savedState, result);
        
        if (!result.stateVerified && result.stateMismatch) {
          if (!this.systemConfig.quiet) {
            printWarning(
              `State mismatch for ${this.name}: ${result.stateMismatch.reason}`
            );
          }
        }
      } else if (savedState && result.status === 'stopped') {
        // Service is stopped but state file exists - stale state
        result.stateVerified = false;
        result.stateMismatch = {
          expected: 'running (state file exists)',
          actual: 'stopped',
          reason: 'Stale state file - service stopped unexpectedly'
        };
        
        // Clean up stale state
        await StateManager.clear(
          this.systemConfig.projectRoot,
          this.systemConfig.environment,
          this.name
        );
      } else if (!savedState && result.status === 'running') {
        // Service is running but no state file
        result.stateVerified = false;
        result.stateMismatch = {
          expected: 'stopped (no state file)',
          actual: 'running',
          reason: 'Service running without state tracking'
        };
      } else {
        // No state file and service not running - consistent
        result.stateVerified = true;
      }
      
      // Perform health check if service is running
      if (result.status === 'running') {
        const healthResult = await this.checkHealth();
        result.health = healthResult;
        
        if (healthResult && !healthResult.healthy) {
          result.status = 'unhealthy';
        }
      }
      
      // Collect logs if available
      if (result.status === 'running' || result.status === 'unhealthy') {
        const logs = await this.platform.collectLogs(this);
        if (logs) {
          result.logs = logs;
        }
      }
      
      if (!this.systemConfig.quiet) {
        const statusIcon = 
          result.status === 'running' ? '✓' :
          result.status === 'unhealthy' ? '⚠' :
          result.status === 'stopped' ? '✗' : '?';
        
        printInfo(`${statusIcon} ${this.name}: ${result.status}`);
      }
      
      return {
        ...result,
        success: true,
        checkTime
      };
      
    } catch (error) {
      if (!this.systemConfig.quiet) {
        printError(`Failed to check ${this.name}: ${error}`);
      }
      
      return {
        service: this.name,
        deployment: this.deployment,
        success: false,
        checkTime,
        status: 'unknown',
        stateVerified: false,
        error: (error as Error).message
      };
    }
  }
  
  async update(): Promise<UpdateResult> {
    const updateTime = new Date();
    
    try {
      if (this.systemConfig.dryRun) {
        if (!this.systemConfig.quiet) {
          printInfo(`[DRY RUN] Would update ${this.name} (${this.deployment})`);
        }
        return {
          service: this.name,
          deployment: this.deployment,
          success: true,
          updateTime,
          strategy: 'none',
          metadata: { dryRun: true }
        };
      }
      
      if (!this.systemConfig.quiet) {
        printInfo(`Updating ${this.name} (${this.deployment})...`);
      }
      
      // Check current state
      const checkResult = await this.check();
      const wasRunning = checkResult.status === 'running';
      
      // Pre-update hook for service-specific preparation
      await this.preUpdate();
      
      // Record downtime start if service was running
      const downtimeStart = wasRunning ? Date.now() : undefined;
      
      // Delegate to platform strategy
      const result = await this.platform.update(this);
      
      // Calculate downtime if applicable
      if (downtimeStart && result.strategy !== 'rolling' && result.strategy !== 'blue-green') {
        result.downtime = Date.now() - downtimeStart;
      }
      
      // Post-update hook for service-specific validation
      await this.postUpdate();
      
      if (!this.systemConfig.quiet) {
        printSuccess(`${this.name} updated successfully`);
        if (result.newVersion) {
          printInfo(`New version: ${result.newVersion}`);
        }
      }
      
      return {
        ...result,
        success: true,
        updateTime
      };
      
    } catch (error) {
      if (!this.systemConfig.quiet) {
        printError(`Failed to update ${this.name}: ${error}`);
      }
      
      return {
        service: this.name,
        deployment: this.deployment,
        success: false,
        updateTime,
        strategy: 'none',
        error: (error as Error).message
      };
    }
  }
  
  async provision(): Promise<ProvisionResult> {
    const provisionTime = new Date();
    
    try {
      if (this.systemConfig.dryRun) {
        if (!this.systemConfig.quiet) {
          printInfo(`[DRY RUN] Would provision ${this.name} (${this.deployment})`);
        }
        return {
          service: this.name,
          deployment: this.deployment,
          success: true,
          provisionTime,
          metadata: { dryRun: true }
        };
      }
      
      if (!this.systemConfig.quiet) {
        printInfo(`Provisioning ${this.name} (${this.deployment})...`);
      }
      
      // Pre-provision hook for service-specific preparation
      await this.preProvision();
      
      // Delegate to platform strategy
      const result = await this.platform.provision(this);
      
      // Post-provision hook for service-specific validation
      await this.postProvision();
      
      if (!this.systemConfig.quiet) {
        printSuccess(`${this.name} provisioned successfully`);
        if (result.cost) {
          printInfo(`Estimated monthly cost: $${result.cost.estimatedMonthly} ${result.cost.currency}`);
        }
        if (result.dependencies && result.dependencies.length > 0) {
          printInfo(`Dependencies: ${result.dependencies.join(', ')}`);
        }
      }
      
      return {
        ...result,
        success: true,
        provisionTime
      };
      
    } catch (error) {
      if (!this.systemConfig.quiet) {
        printError(`Failed to provision ${this.name}: ${error}`);
      }
      
      return {
        service: this.name,
        deployment: this.deployment,
        success: false,
        provisionTime,
        error: (error as Error).message
      };
    }
  }
  
  async publish(): Promise<PublishResult> {
    const publishTime = new Date();
    
    try {
      if (this.systemConfig.dryRun) {
        if (!this.systemConfig.quiet) {
          printInfo(`[DRY RUN] Would publish ${this.name} (${this.deployment})`);
        }
        return {
          service: this.name,
          deployment: this.deployment,
          success: true,
          publishTime,
          metadata: { dryRun: true }
        };
      }
      
      if (!this.systemConfig.quiet) {
        printInfo(`Publishing ${this.name} (${this.deployment})...`);
      }
      
      // Pre-publish hook for service-specific preparation
      await this.prePublish();
      
      // Delegate to platform strategy
      const result = await this.platform.publish(this);
      
      // Post-publish hook for service-specific validation
      await this.postPublish();
      
      if (!this.systemConfig.quiet) {
        printSuccess(`${this.name} published successfully`);
        if (result.version?.current) {
          printInfo(`Published version: ${result.version.current}`);
        }
        if (result.artifacts?.imageUrl) {
          printInfo(`Image: ${result.artifacts.imageUrl}`);
        }
        if (result.artifacts?.staticSiteUrl) {
          printInfo(`Site: ${result.artifacts.staticSiteUrl}`);
        }
        if (result.rollback?.supported) {
          printInfo(`Rollback available: ${result.rollback.command || 'Yes'}`);
        }
      }
      
      return {
        ...result,
        success: true,
        publishTime
      };
      
    } catch (error) {
      if (!this.systemConfig.quiet) {
        printError(`Failed to publish ${this.name}: ${error}`);
      }
      
      return {
        service: this.name,
        deployment: this.deployment,
        success: false,
        publishTime,
        error: (error as Error).message
      };
    }
  }
  
  async backup(): Promise<BackupResult> {
    const backupTime = new Date();
    
    try {
      if (this.systemConfig.dryRun) {
        if (!this.systemConfig.quiet) {
          printInfo(`[DRY RUN] Would backup ${this.name} (${this.deployment})`);
        }
        return {
          service: this.name,
          deployment: this.deployment,
          success: true,
          backupTime,
          backupId: `${this.name}-${this.systemConfig.environment}-dry-run`,
          metadata: { dryRun: true }
        };
      }
      
      if (!this.systemConfig.quiet) {
        printInfo(`Backing up ${this.name} (${this.deployment})...`);
      }
      
      // Pre-backup hook for service-specific preparation
      await this.preBackup();
      
      // Delegate to platform strategy
      const result = await this.platform.backup(this);
      
      // Post-backup hook for service-specific validation
      await this.postBackup();
      
      if (!this.systemConfig.quiet) {
        if (result.success) {
          printSuccess(`${this.name} backed up successfully`);
          if (result.backup?.size) {
            const sizeMB = Math.round(result.backup.size / 1024 / 1024 * 100) / 100;
            printInfo(`Backup size: ${sizeMB} MB`);
          }
          if (result.backup?.location) {
            printInfo(`Backup location: ${result.backup.location}`);
          }
          if (result.restore?.supported) {
            printInfo(`Restore supported: ${result.restore.command || 'Yes'}`);
          }
        } else {
          printError(`Failed to backup ${this.name}: ${result.error}`);
        }
      }
      
      return {
        ...result,
        success: result.success,
        backupTime
      };
      
    } catch (error) {
      if (!this.systemConfig.quiet) {
        printError(`Failed to backup ${this.name}: ${error}`);
      }
      
      return {
        service: this.name,
        deployment: this.deployment,
        success: false,
        backupTime,
        backupId: `${this.name}-${this.systemConfig.environment}-failed`,
        error: (error as Error).message
      };
    }
  }
  
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const execTime = new Date();
    
    try {
      if (this.systemConfig.dryRun) {
        if (!this.systemConfig.quiet) {
          printInfo(`[DRY RUN] Would execute '${command}' in ${this.name} (${this.deployment})`);
        }
        return {
          service: this.name,
          deployment: this.deployment,
          success: true,
          execTime,
          command,
          execution: {
            workingDirectory: options.workingDirectory,
            user: options.user,
            shell: options.shell,
            interactive: options.interactive,
            tty: options.tty
          },
          metadata: { dryRun: true }
        };
      }
      
      // Check if service is running (for most platforms)
      if (this.deployment !== 'external') {
        const checkResult = await this.check();
        if (checkResult.status === 'stopped') {
          if (!this.systemConfig.quiet) {
            printWarning(`Service ${this.name} is not running`);
          }
          return {
            service: this.name,
            deployment: this.deployment,
            success: false,
            execTime,
            command,
            error: `Service ${this.name} is not running. Start the service first.`
          };
        }
      }
      
      if (!this.systemConfig.quiet) {
        printInfo(`Executing command in ${this.name} (${this.deployment}): ${command}`);
      }
      
      // Pre-exec hook for service-specific preparation
      await this.preExec(command, options);
      
      // Delegate to platform strategy
      const result = await this.platform.exec(this, command, options);
      
      // Post-exec hook for service-specific validation
      await this.postExec(result);
      
      if (!this.systemConfig.quiet) {
        if (result.success) {
          if (result.execution?.exitCode === 0) {
            printSuccess(`Command executed successfully in ${this.name}`);
          } else {
            printWarning(`Command completed with exit code ${result.execution?.exitCode}`);
          }
          
          // Display output if captured and not too large
          if (result.output?.stdout && result.output.stdout.length < 1000) {
            console.log('Output:', result.output.stdout);
          } else if (result.output?.stdout) {
            console.log(`Output: ${result.output.stdout.length} bytes captured`);
          }
          
          if (result.output?.stderr) {
            console.log('Errors:', result.output.stderr);
          }
          
          if (result.execution?.duration) {
            printInfo(`Execution time: ${result.execution.duration}ms`);
          }
        } else {
          printError(`Failed to execute command in ${this.name}: ${result.error}`);
          
          // Show recommendations for external services
          if (this.deployment === 'external' && result.metadata?.recommendations) {
            console.log('Recommendations:');
            result.metadata.recommendations.forEach((rec: string) => {
              console.log(`  • ${rec}`);
            });
          }
        }
      }
      
      return result;
      
    } catch (error) {
      if (!this.systemConfig.quiet) {
        printError(`Failed to execute command in ${this.name}: ${error}`);
      }
      
      return {
        service: this.name,
        deployment: this.deployment,
        success: false,
        execTime,
        command,
        error: (error as Error).message
      };
    }
  }
  
  // =====================================================================
  // Hooks for service-specific logic
  // Override these in service implementations
  // =====================================================================
  
  protected async preStart(): Promise<void> {
    // Override in subclasses for service-specific setup
  }
  
  protected async postStart(): Promise<void> {
    // Override in subclasses for service-specific validation
  }
  
  protected async preStop(): Promise<void> {
    // Override in subclasses for service-specific cleanup
  }
  
  protected async postStop(): Promise<void> {
    // Override in subclasses for service-specific validation
  }
  
  protected async preUpdate(): Promise<void> {
    // Override in subclasses for service-specific preparation
  }
  
  protected async postUpdate(): Promise<void> {
    // Override in subclasses for service-specific validation
  }
  
  protected async preProvision(): Promise<void> {
    // Override in subclasses for service-specific preparation
  }
  
  protected async postProvision(): Promise<void> {
    // Override in subclasses for service-specific validation
  }
  
  async test(options: TestOptions = {}): Promise<TestResult> {
    const testTime = new Date();
    
    try {
      if (this.systemConfig.dryRun) {
        if (!this.systemConfig.quiet) {
          printInfo(`[DRY RUN] Would run tests for ${this.name} (${this.deployment})`);
        }
        return {
          service: this.name,
          deployment: this.deployment,
          success: true,
          testTime,
          suite: options.suite || 'unit',
          metadata: { dryRun: true }
        };
      }
      
      // Pre-test hook
      await this.preTest(options);
      
      // Delegate to platform strategy
      const result = await this.platform.test(this, options);
      
      // Post-test hook  
      await this.postTest(result);
      
      // Display results
      if (!this.systemConfig.quiet) {
        if (result.success) {
          printSuccess(`✅ ${this.name} (${this.deployment}): Tests passed`);
          if (result.tests) {
            printInfo(`   🧪 Tests: ${result.tests.passed} passed, ${result.tests.failed || 0} failed (${((result.tests.duration || 0)/1000).toFixed(1)}s)`);
          }
          if (result.coverage?.enabled) {
            printInfo(`   📊 Coverage: Lines: ${result.coverage.lines}% Branches: ${result.coverage.branches}%`);
          }
        } else {
          printError(`❌ ${this.name} (${this.deployment}): Tests failed`);
          if (result.tests && result.tests.failed && result.tests.failed > 0) {
            printError(`   🧪 ${result.tests.failed} test(s) failed`);
          }
          if (result.error) {
            printError(`   Error: ${result.error}`);
          }
        }
      }
      
      return result;
    } catch (error) {
      const errorMessage = (error as Error).message;
      if (!this.systemConfig.quiet) {
        printError(`Failed to run tests for ${this.name}: ${errorMessage}`);
      }
      return {
        service: this.name,
        deployment: this.deployment,
        success: false,
        testTime,
        suite: options.suite || 'unit',
        error: errorMessage
      };
    }
  }
  
  async restore(backupId: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    const restoreTime = new Date();
    
    try {
      if (this.systemConfig.dryRun) {
        if (!this.systemConfig.quiet) {
          printInfo(`[DRY RUN] Would restore ${this.name} from backup ${backupId}`);
        }
        return {
          service: this.name,
          deployment: this.deployment,
          success: true,
          restoreTime,
          backupId,
          metadata: { dryRun: true }
        };
      }
      
      // Pre-restore hook
      await this.preRestore(backupId, options);
      
      // Delegate to platform strategy
      const result = await this.platform.restore(this, backupId, options);
      
      // Post-restore hook
      await this.postRestore(result);
      
      // Display results
      if (!this.systemConfig.quiet) {
        if (result.success) {
          printSuccess(`✅ ${this.name} (${this.deployment}): Restore completed`);
          if (result.restore) {
            printInfo(`   📦 Restored from: ${result.restore.source}`);
            if (result.restore.database) {
              printInfo(`   🗄️ Database: ${result.restore.database.tables} tables, ${result.restore.database.records} records`);
            }
            if (result.restore.filesystem) {
              printInfo(`   📁 Filesystem: ${result.restore.filesystem.files} files, ${result.restore.filesystem.directories} directories`);
            }
          }
          if (result.validation?.healthCheck) {
            printSuccess(`   ✓ Health check passed`);
          }
          if (result.downtime?.duration) {
            printInfo(`   ⏱️ Downtime: ${(result.downtime.duration/1000).toFixed(1)}s`);
          }
          if (result.rollback?.supported) {
            printInfo(`   ↩️ Rollback available: ${result.rollback.command}`);
          }
        } else {
          printError(`❌ ${this.name} (${this.deployment}): Restore failed`);
          if (result.error) {
            printError(`   Error: ${result.error}`);
          }
          if (result.warnings?.length) {
            result.warnings.forEach(warning => {
              printWarning(`   ⚠️ ${warning}`);
            });
          }
        }
      }
      
      return result;
    } catch (error) {
      const errorMessage = (error as Error).message;
      if (!this.systemConfig.quiet) {
        printError(`Failed to restore ${this.name}: ${errorMessage}`);
      }
      return {
        service: this.name,
        deployment: this.deployment,
        success: false,
        restoreTime,
        backupId,
        error: errorMessage
      };
    }
  }
  
  protected async prePublish(): Promise<void> {
    // Override in subclasses for service-specific preparation
  }
  
  protected async postPublish(): Promise<void> {
    // Override in subclasses for service-specific validation
  }
  
  protected async preBackup(): Promise<void> {
    // Override in subclasses for service-specific preparation
  }
  
  protected async postBackup(): Promise<void> {
    // Override in subclasses for service-specific validation
  }
  
  protected async preExec(_command: string, _options: ExecOptions): Promise<void> {
    // Override in subclasses for service-specific preparation
  }
  
  protected async postExec(_result: ExecResult): Promise<void> {
    // Override in subclasses for service-specific validation
  }
  
  protected async preTest(_options: TestOptions): Promise<void> {
    // Override in subclasses for service-specific preparation
  }
  
  protected async postTest(_result: TestResult): Promise<void> {
    // Override in subclasses for service-specific validation
  }
  
  protected async preRestore(_backupId: string, _options: RestoreOptions): Promise<void> {
    // Override in subclasses for service-specific preparation
  }
  
  protected async postRestore(_result: RestoreResult): Promise<void> {
    // Override in subclasses for service-specific validation
  }
  
  // Verify that saved state matches actual state
  protected async verifyState(
    savedState: ServiceState,
    checkResult: CheckResult
  ): Promise<boolean> {
    // Override in subclasses for specific verification
    // Base implementation just checks if resource IDs match
    if (savedState.resourceId.pid && checkResult.resources?.pid) {
      return savedState.resourceId.pid === checkResult.resources.pid;
    }
    if (savedState.resourceId.containerId && checkResult.resources?.containerId) {
      return savedState.resourceId.containerId === checkResult.resources.containerId;
    }
    return true;
  }
  
  // Health check - override for service-specific endpoints
  protected async checkHealth(): Promise<CheckResult['health']> {
    // Default implementation - no health check
    return {
      healthy: true,
      details: { message: 'No health endpoint configured' }
    };
  }
  
  // =====================================================================
  // State management helpers
  // =====================================================================
  
  protected async saveState(result: StartResult): Promise<void> {
    const state: ServiceState = {
      service: this.name,
      deployment: this.deployment,
      environment: this.systemConfig.environment,
      startTime: result.startTime.toISOString(),
      resourceId: {
        pid: result.pid,
        containerId: result.containerId,
        containerName: result.metadata?.containerName,
        port: result.metadata?.port,
        endpoint: result.endpoint
      },
      metadata: result.metadata
    };
    
    await StateManager.save(
      this.systemConfig.projectRoot,
      this.systemConfig.environment,
      this.name,
      state
    );
  }
  
  protected async loadState(): Promise<ServiceState | null> {
    return await StateManager.load(
      this.systemConfig.projectRoot,
      this.systemConfig.environment,
      this.name
    );
  }
  
  // Helper methods for environment variables
  protected getEnvVar(key: string): string | undefined {
    return this.envVars[key];
  }
  
  protected setEnvVar(key: string, value: string): void {
    this.envVars[key] = value;
  }
}