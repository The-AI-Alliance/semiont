/**
 * Process Platform Strategy
 * 
 * Runs services as native OS processes on the local machine. This platform is ideal for
 * development environments and simple deployments where containerization isn't needed.
 * 
 * Capabilities:
 * - Spawns services as child processes with environment variables
 * - Manages process lifecycle (start, stop, restart)
 * - Tracks running processes via PID files in the state directory
 * - Supports port allocation and basic health checks
 * - Provides process-level isolation through OS mechanisms
 * 
 * Requirements Handling:
 * - Compute: Uses OS-level resource limits where available
 * - Network: Binds to specified ports, checks for conflicts
 * - Storage: Uses local filesystem paths
 * - Dependencies: Verifies dependent processes are running via PID checks
 */

import { spawn, execSync } from 'child_process';
import * as path from "path";
import * as fs from 'fs';
import { StartResult } from "../commands/start.js";
import { StopResult } from "../commands/stop.js";
import { CheckResult } from "../commands/check.js";
import { UpdateResult } from "../commands/update.js";
import { ProvisionResult } from "../commands/provision.js";
import { PublishResult } from "../commands/publish.js";
import { BackupResult } from "../commands/backup.js";
import { PlatformResources } from "./platform-resources.js";
import { ExecResult, ExecOptions } from "../commands/exec.js";
import { TestResult, TestOptions } from "../commands/test.js";
import { RestoreResult, RestoreOptions } from "../commands/restore.js";
import { BasePlatformStrategy, ServiceContext } from './platform-strategy.js';
import { StateManager } from '../services/state-manager.js';
import { printInfo, printWarning } from '../lib/cli-logger.js';
import { isPortInUse } from '../lib/network-utils.js';

export class ProcessPlatformStrategy extends BasePlatformStrategy {
  getPlatformName(): string {
    return 'process';
  }
  
  async start(context: ServiceContext): Promise<StartResult> {
    const requirements = context.getRequirements();
    const command = context.getCommand();
    
    // Check network port availability
    const primaryPort = requirements.network?.ports?.[0];
    if (primaryPort && await isPortInUse(primaryPort)) {
      throw new Error(`Port ${primaryPort} is already in use`);
    }
    
    // Check dependencies are running
    const dependencies = requirements.dependencies?.services || [];
    for (const dep of dependencies) {
      const depState = await StateManager.load(
        context.projectRoot,
        context.environment,
        dep
      );
      
      if (!depState) {
        printWarning(`Dependency '${dep}' has never been started`);
      } else {
        // Verify the dependency is actually running
        let isRunning = false;
        
        // Use the appropriate platform strategy to check if running
        const { PlatformFactory } = await import('./index.js');
        const platform = PlatformFactory.getPlatform(depState.platform);
        
        if (platform.quickCheckRunning) {
          isRunning = await platform.quickCheckRunning(depState);
        } else {
          // For platforms without quickCheckRunning (AWS, external, mock),
          // assume they're running if state exists
          isRunning = true;
        }
        
        if (!isRunning) {
          printWarning(`Dependency '${dep}' is not running`);
          
          // Note: Auto-starting dependencies could be added here in the future
          // This would require creating a minimal service context and calling start()
        }
      }
    }
    
    // Build environment from requirements
    const env = {
      ...process.env,
      ...context.getEnvironmentVariables(),
      ...(requirements.environment || {}),
      NODE_ENV: context.environment
    };
    
    // Add port if specified in network requirements
    if (primaryPort) {
      (env as any).PORT = primaryPort.toString();
    }
    
    // Parse command
    const [cmd, ...args] = command.split(' ');
    
    // Spawn the process with requirements-based configuration
    const proc = spawn(cmd, args, {
      cwd: context.projectRoot,
      env,
      detached: true,
      stdio: context.verbose ? 'inherit' : 'ignore'
    });
    
    if (!proc.pid) {
      throw new Error('Failed to start process');
    }
    
    proc.unref();
    
    // Build endpoint from network requirements
    let endpoint: string | undefined;
    if (primaryPort) {
      // Protocol is tcp/udp, but for endpoint we use http/https
      const protocol = 'http'; // Default to http for process platform
      endpoint = `${protocol}://localhost:${primaryPort}`;
    }
    
    return {
      entity: context.name,
      platform: 'process',
      success: true,
      startTime: new Date(),
      endpoint,
      resources: {
        platform: 'process',
        data: {
          pid: proc.pid,
          port: primaryPort
        }
      },
      metadata: {
        command,
        port: primaryPort,
        dependencies: dependencies.length > 0 ? dependencies : undefined,
        environment: Object.keys(requirements.environment || {})
      }
    };
  }
  
  async stop(context: ServiceContext): Promise<StopResult> {
    // Load saved state to get PID
    const savedState = await StateManager.load(
      context.projectRoot,
      context.environment,
      context.name
    );
    
    const savedPid = savedState?.resources?.platform === 'process' ? 
      savedState.resources.data.pid : undefined;
    
    if (!savedPid) {
      // Try to find process by port from requirements
      const requirements = context.getRequirements();
      const port = requirements.network?.ports?.[0];
      
      if (port) {
        try {
          const pid = this.findProcessByPort(port);
          if (pid) {
            process.kill(pid, 'SIGTERM');
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (StateManager.isProcessRunning(pid)) {
              process.kill(pid, 'SIGKILL');
            }
          }
        } catch {
          // Process might not exist
        }
      }
      
      return {
        entity: context.name,
        platform: 'process',
        success: true,
        stopTime: new Date(),
        metadata: {
          message: 'No saved process found'
        }
      };
    }
    
    const pid = savedPid;
    
    try {
      process.kill(pid, 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      if (StateManager.isProcessRunning(pid)) {
        process.kill(pid, 'SIGKILL');
      }
      
      return {
        entity: context.name,
        platform: 'process',
        success: true,
        stopTime: new Date(),
        gracefulShutdown: true,
        metadata: {
          pid
        }
      };
    } catch (error) {
      return {
        entity: context.name,
        platform: 'process',
        success: true,
        stopTime: new Date(),
        metadata: {
          message: 'Process already stopped'
        }
      };
    }
  }
  
  async check(context: ServiceContext): Promise<CheckResult> {
    const requirements = context.getRequirements();
    const savedState = await StateManager.load(
      context.projectRoot,
      context.environment,
      context.name
    );
    
    let status: CheckResult['status'] = 'stopped';
    let pid: number | undefined;
    
    // Check if saved process is running
    if (savedState?.resources?.platform === 'process' && 
        savedState.resources.data.pid && 
        StateManager.isProcessRunning(savedState.resources.data.pid)) {
      pid = savedState.resources.data.pid;
      status = 'running';
    } else {
      // Try to find process by port from requirements
      const port = requirements.network?.ports?.[0];
      if (port && await isPortInUse(port)) {
        try {
          pid = this.findProcessByPort(port);
          if (pid) {
            status = 'running';
          }
        } catch {
          // Couldn't determine PID
        }
      }
    }
    
    // Collect logs if running
    let logs: CheckResult['logs'] | undefined;
    if (status === 'running') {
      logs = await this.collectLogs(context);
    }
    
    // Health check based on requirements
    let health: CheckResult['health'] | undefined;
    if (status === 'running' && requirements.network?.healthCheckPath) {
      const port = requirements.network.healthCheckPort || requirements.network.ports?.[0];
      if (port) {
        const healthUrl = `http://localhost:${port}${requirements.network.healthCheckPath}`;
        try {
          const response = await fetch(healthUrl, {
            signal: AbortSignal.timeout(5000)
          });
          health = {
            endpoint: healthUrl,
            statusCode: response.status,
            healthy: response.ok,
            details: { status: response.ok ? 'healthy' : 'unhealthy' }
          };
        } catch (error) {
          health = {
            endpoint: healthUrl,
            healthy: false,
            details: { error: (error as Error).message }
          };
        }
      }
    }
    
    return {
      entity: context.name,
      platform: 'process',
      success: true,
      checkTime: new Date(),
      status,
      stateVerified: true,
      resources: {
        platform: 'process',
        data: {
          pid,
          port: requirements.network?.ports?.[0]
        }
      } as PlatformResources,
      health,
      logs
    };
  }
  
  async update(context: ServiceContext): Promise<UpdateResult> {
    // For process: stop and restart
    const stopResult = await this.stop(context);
    
    // Clear state
    await StateManager.clear(
      context.projectRoot,
      context.environment,
      context.name
    );
    
    // Start new version
    const startResult = await this.start(context);
    
    return {
      entity: context.name,
      platform: 'process',
      success: true,
      updateTime: new Date(),
      strategy: 'restart',
      metadata: {
        stopped: stopResult.success,
        started: startResult.success
      }
    };
  }
  
  async provision(context: ServiceContext): Promise<ProvisionResult> {
    const requirements = context.getRequirements();
    
    if (!context.quiet) {
      printInfo(`Provisioning ${context.name} for process deployment...`);
    }
    
    const dependencies = requirements.dependencies?.services || [];
    const metadata: any = {};
    
    // Create base directories
    const logsPath = path.join(context.projectRoot, 'logs');
    const dataPath = path.join(context.projectRoot, 'data');
    
    await fs.promises.mkdir(logsPath, { recursive: true });
    await fs.promises.mkdir(dataPath, { recursive: true });
    metadata.logsPath = logsPath;
    metadata.dataPath = dataPath;
    
    // Create storage directories based on requirements
    if (requirements.storage) {
      for (const storage of requirements.storage) {
        if (storage.persistent) {
          const storagePath = storage.mountPath?.startsWith('/') 
            ? path.join(dataPath, path.basename(storage.mountPath))
            : path.join(dataPath, storage.mountPath || context.name);
          
          await fs.promises.mkdir(storagePath, { recursive: true });
          
          if (!context.quiet) {
            printInfo(`Created storage directory: ${storagePath}`);
          }
          
          metadata[`storage_${storage.volumeName || 'default'}`] = storagePath;
        }
      }
    }
    
    // Install dependencies if build requirements specify it
    if (requirements.build && !requirements.build.prebuilt) {
      const servicePath = path.join(context.projectRoot, 'apps', context.name);
      const buildContext = requirements.build.buildContext || servicePath;
      
      // Check for package.json (Node.js project)
      if (fs.existsSync(path.join(buildContext, 'package.json'))) {
        if (!context.quiet) {
          printInfo(`Installing dependencies for ${context.name}...`);
        }
        execSync('npm install', { cwd: buildContext });
        
        // Build if specified
        if (requirements.build.buildArgs?.BUILD === 'true') {
          if (!context.quiet) {
            printInfo(`Building ${context.name}...`);
          }
          execSync('npm run build', { cwd: buildContext });
        }
      }
      
      // Check for requirements.txt (Python project)
      else if (fs.existsSync(path.join(buildContext, 'requirements.txt'))) {
        if (!context.quiet) {
          printInfo(`Installing Python dependencies for ${context.name}...`);
        }
        execSync('pip install -r requirements.txt', { cwd: buildContext });
      }
      
      metadata.buildContext = buildContext;
    }
    
    // Check external dependencies
    if (requirements.dependencies?.external) {
      for (const ext of requirements.dependencies.external) {
        if (ext.required) {
          // Check if external dependency is available
          if (ext.healthCheck) {
            try {
              const response = await fetch(ext.healthCheck, {
                signal: AbortSignal.timeout(5000)
              });
              if (!response.ok && ext.required) {
                throw new Error(`Required external dependency '${ext.name}' is not available`);
              }
            } catch (error) {
              if (ext.required) {
                throw new Error(`Required external dependency '${ext.name}' is not reachable: ${error}`);
              } else {
                printWarning(`Optional dependency '${ext.name}' is not available`);
              }
            }
          }
        }
      }
    }
    
    // Check port availability from network requirements
    if (requirements.network?.ports) {
      for (const port of requirements.network.ports) {
        if (await isPortInUse(port)) {
          throw new Error(`Port ${port} is already in use`);
        }
      }
      metadata.ports = requirements.network.ports;
    }
    
    // Set up security requirements (permissions, user, etc.)
    if (requirements.security) {
      // In process mode, we can't fully enforce security requirements
      // but we can document them
      metadata.security = {
        runAsUser: requirements.security.runAsUser,
        runAsGroup: requirements.security.runAsGroup,
        secrets: requirements.security.secrets?.length || 0
      };
    }
    
    return {
      entity: context.name,
      platform: 'process',
      success: true,
      provisionTime: new Date(),
      dependencies,
      metadata
    };
  }
  
  async publish(context: ServiceContext): Promise<PublishResult> {
    const requirements = context.getRequirements();
    
    if (!context.quiet) {
      printInfo(`Publishing ${context.name} for process deployment...`);
    }
    
    const artifacts: PublishResult['artifacts'] = {};
    const version: PublishResult['version'] = {};
    const rollback: PublishResult['rollback'] = { supported: false };
    
    // Get version from package.json if available
    const servicePath = path.join(context.projectRoot, 'apps', context.name);
    try {
      const packageJsonPath = path.join(servicePath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        version.current = pkg.version;
        artifacts.packageName = pkg.name;
        artifacts.packageVersion = pkg.version;
      }
    } catch {
      version.current = '1.0.0';
    }
    
    // Get git info
    try {
      const commitSha = execSync('git rev-parse HEAD', { 
        cwd: context.projectRoot, 
        encoding: 'utf-8' 
      }).trim();
      artifacts.commitSha = commitSha.substring(0, 7);
      
      const branch = execSync('git branch --show-current', { 
        cwd: context.projectRoot, 
        encoding: 'utf-8' 
      }).trim();
      artifacts.branch = branch;
    } catch {
      // Not in git repo
    }
    
    // Build based on requirements
    if (requirements.build && !requirements.build.prebuilt) {
      const buildContext = requirements.build.buildContext || servicePath;
      
      // Node.js project
      if (fs.existsSync(path.join(buildContext, 'package.json'))) {
        if (!context.quiet) {
          printInfo(`Building ${context.name}...`);
        }
        
        // Install dependencies
        execSync('npm install', { cwd: buildContext });
        
        // Build
        if (fs.existsSync(path.join(buildContext, 'tsconfig.json'))) {
          execSync('npm run build', { cwd: buildContext });
        }
        
        // Check for output
        const distPath = path.join(buildContext, 'dist');
        const buildPath = path.join(buildContext, 'build');
        
        if (fs.existsSync(distPath)) {
          artifacts.bundleUrl = `file://${distPath}`;
        } else if (fs.existsSync(buildPath)) {
          artifacts.bundleUrl = `file://${buildPath}`;
        }
        
        rollback.supported = true;
        rollback.command = `cd ${buildContext} && git checkout HEAD~1 && npm install && npm run build`;
      }
      
      // Python project
      else if (fs.existsSync(path.join(buildContext, 'setup.py'))) {
        if (!context.quiet) {
          printInfo(`Building Python package for ${context.name}...`);
        }
        
        execSync('python setup.py bdist_wheel', { cwd: buildContext });
        
        const distPath = path.join(buildContext, 'dist');
        if (fs.existsSync(distPath)) {
          const wheels = fs.readdirSync(distPath).filter(f => f.endsWith('.whl'));
          if (wheels.length > 0) {
            artifacts.bundleUrl = `file://${path.join(distPath, wheels[0])}`;
            artifacts.packageVersion = wheels[0].match(/-([\d.]+)-/)?.[1] || '1.0.0';
          }
        }
      }
      
      // Generic build command from requirements
      else if (requirements.build.buildArgs?.BUILD_COMMAND) {
        const buildCommand = requirements.build.buildArgs.BUILD_COMMAND;
        if (!context.quiet) {
          printInfo(`Running build command: ${buildCommand}`);
        }
        execSync(buildCommand, { cwd: buildContext });
      }
    }
    
    // Handle static sites (if network requirements indicate it)
    if (requirements.network?.needsLoadBalancer && fs.existsSync(path.join(servicePath, 'dist'))) {
      // Could copy dist files to a web server location if needed
      artifacts.staticSiteUrl = `http://localhost:${requirements.network.ports?.[0] || 80}`;
    }
    
    // Package for distribution if specified
    if (requirements.annotations?.['publish/package'] === 'true') {
      const packagePath = path.join(servicePath, `${context.name}-${version.current}.tar.gz`);
      execSync(`tar -czf ${packagePath} .`, { cwd: servicePath });
      artifacts.bundleUrl = `file://${packagePath}`;
    }
    
    return {
      entity: context.name,
      platform: 'process',
      success: true,
      publishTime: new Date(),
      artifacts,
      version,
      rollback,
      metadata: {
        servicePath,
        buildTime: new Date().toISOString(),
        buildRequirements: requirements.build
      }
    };
  }
  
  async backup(context: ServiceContext): Promise<BackupResult> {
    const requirements = context.getRequirements();
    const backupId = `${context.name}-${context.environment}-${Date.now()}`;
    const backupDir = path.join(context.projectRoot, '.semiont', 'backups', context.environment);
    
    // Create backup directory
    fs.mkdirSync(backupDir, { recursive: true });
    
    const backup: BackupResult['backup'] = {
      size: 0,
      location: '',
      format: 'tar',
      compression: 'gzip',
      encrypted: false
    };
    
    const restore = {
      supported: true,
      command: '',
      requirements: ['Service must be stopped', 'Backup file must exist']
    };
    
    if (!context.quiet) {
      printInfo(`Creating backup for ${context.name} (process platform)...`);
    }
    
    try {
      const servicePath = path.join(context.projectRoot, 'apps', context.name);
      const backupPath = path.join(backupDir, `${backupId}.tar.gz`);
      const itemsToBackup: string[] = [];
      
      // Backup persistent storage based on requirements
      if (requirements.storage) {
        for (const storage of requirements.storage) {
          if (storage.persistent && storage.backupEnabled !== false) {
            const storagePath = storage.mountPath?.startsWith('/')
              ? path.join(context.projectRoot, 'data', path.basename(storage.mountPath))
              : path.join(context.projectRoot, 'data', storage.mountPath || context.name);
            
            if (fs.existsSync(storagePath)) {
              // Add to items to backup (relative path for tar)
              const relativePath = path.relative(context.projectRoot, storagePath);
              itemsToBackup.push(relativePath);
              
              if (backup) {
                if (!backup.details) {
                  backup.details = { type: 'filesystem', paths: [], preservePermissions: true };
                }
                if (!backup.details.paths) {
                  backup.details.paths = [];
                }
                backup.details.paths.push(storagePath);
              }
            }
          }
        }
      }
      
      // Backup configuration files
      const configFiles = ['.env', '.env.local', 'config.json', 'settings.json'];
      for (const configFile of configFiles) {
        const configPath = path.join(servicePath, configFile);
        if (fs.existsSync(configPath)) {
          const relativePath = path.relative(context.projectRoot, configPath);
          itemsToBackup.push(relativePath);
          
          if (backup) {
            if (!backup.details) {
              backup.details = { envFiles: [], configMaps: [] };
            }
            if (!backup.details.envFiles) {
              backup.details.envFiles = [];
            }
            if (!backup.details.configMaps) {
              backup.details.configMaps = [];
            }
            
            if (configFile.startsWith('.env')) {
              backup.details.envFiles.push(configFile);
            } else {
              backup.details.configMaps.push(configFile);
            }
          }
        }
      }
      
      // Backup logs if specified
      if (requirements.annotations?.['backup/logs'] === 'true') {
        const logsPath = path.join(servicePath, 'logs');
        if (fs.existsSync(logsPath)) {
          const relativePath = path.relative(context.projectRoot, logsPath);
          itemsToBackup.push(relativePath);
          
          if (!backup.application) {
            backup.application = { source: false, assets: false, logs: false };
          }
          backup.application.logs = true;
        }
      }
      
      // Backup application assets if specified
      if (requirements.annotations?.['backup/assets'] === 'true') {
        const assetsPath = path.join(servicePath, 'assets');
        if (fs.existsSync(assetsPath)) {
          const relativePath = path.relative(context.projectRoot, assetsPath);
          itemsToBackup.push(relativePath);
          
          if (!backup.application) {
            backup.application = { source: false, assets: false, logs: false };
          }
          backup.application.assets = true;
        }
      }
      
      if (itemsToBackup.length === 0) {
        throw new Error(`No data to backup for ${context.name}`);
      }
      
      // Create the backup
      execSync(
        `tar -czf "${backupPath}" -C "${context.projectRoot}" ${itemsToBackup.join(' ')}`,
        { cwd: context.projectRoot }
      );
      
      backup.size = fs.statSync(backupPath).size;
      backup.location = backupPath;
      restore.command = `tar -xzf "${backupPath}" -C "${context.projectRoot}"`;
      
      // Calculate checksum
      const checksum = execSync(`shasum -a 256 "${backup.location}"`, { encoding: 'utf-8' })
        .split(' ')[0];
      backup.checksum = checksum;
      
      // Set retention based on requirements or default
      const retentionDays = requirements.annotations?.['backup/retention'] 
        ? parseInt(requirements.annotations['backup/retention'])
        : 30;
      
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + retentionDays);
      
      if (!context.quiet) {
        printInfo(`Backup created: ${path.basename(backup.location!)} (${Math.round(backup.size! / 1024 / 1024 * 100) / 100} MB)`);
      }
      
      return {
        entity: context.name,
        platform: 'process',
        success: true,
        backupTime: new Date(),
        backupId,
        backup,
        retention: {
          expiresAt,
          policy: retentionDays > 30 ? 'yearly' : retentionDays > 7 ? 'monthly' : 'weekly',
          autoCleanup: true
        },
        restore,
        metadata: {
          platform: 'process',
          compression: backup.compression,
          integrity: 'sha256',
          storageRequirements: requirements.storage
        }
      };
      
    } catch (error) {
      return {
        entity: context.name,
        platform: 'process',
        success: false,
        backupTime: new Date(),
        backupId,
        error: (error as Error).message
      };
    }
  }
  
  async exec(context: ServiceContext, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const requirements = context.getRequirements();
    const execTime = new Date();
    const startTime = Date.now();
    
    // Determine working directory
    const servicePath = path.join(context.projectRoot, 'apps', context.name);
    const workingDirectory = options.workingDirectory || servicePath;
    
    // Check if service directory exists
    if (!fs.existsSync(workingDirectory)) {
      return {
        entity: context.name,
        platform: 'process',
        success: false,
        execTime,
        command,
        error: `Working directory does not exist: ${workingDirectory}`
      };
    }
    
    // Build environment variables from requirements
    const env = {
      ...process.env,
      ...context.getEnvironmentVariables(),
      ...(requirements.environment || {}),
      NODE_ENV: context.environment,
      SERVICE_NAME: context.name
    };
    
    // Add secrets from requirements if available
    if (requirements.security?.secrets) {
      for (const secret of requirements.security.secrets) {
        const envVar = process.env[secret];
        if (envVar) {
          (env as any)[secret] = envVar;
        }
      }
    }
    
    // Determine shell to use
    const shell = options.shell || (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash');
    
    if (!context.quiet) {
      printInfo(`Executing in ${context.name} (process): ${command}`);
    }
    
    try {
      // Interactive commands not supported in process platform
      if (options.interactive || options.tty) {
        return {
          entity: context.name,
          platform: 'process',
          success: false,
          execTime,
          command,
          execution: {
            workingDirectory,
            shell,
            interactive: true,
            tty: options.tty
          },
          error: 'Interactive execution not supported in process platform. Use container platform for interactive sessions.'
        };
      }
      
      // Non-interactive execution
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      
      try {
        if (options.captureOutput !== false) {
          const result = execSync(command, {
            cwd: workingDirectory,
            env,
            shell,
            encoding: 'utf-8',
            timeout: options.timeout,
            maxBuffer: 1024 * 1024 * 10 // 10MB buffer
          });
          stdout = result.toString();
        } else {
          execSync(command, {
            cwd: workingDirectory,
            env,
            shell,
            stdio: 'inherit',
            timeout: options.timeout
          });
        }
      } catch (error: any) {
        exitCode = error.status || 1;
        stdout = error.stdout?.toString() || '';
        stderr = error.stderr?.toString() || error.message;
        
        if (error.code === 'ETIMEDOUT') {
          stderr = `Command timed out after ${options.timeout}ms\n${stderr}`;
        }
      }
      
      const duration = Date.now() - startTime;
      
      // Check if output was truncated
      const maxOutputSize = 1024 * 1024; // 1MB
      const truncated = stdout.length > maxOutputSize || stderr.length > maxOutputSize;
      
      if (truncated) {
        stdout = stdout.substring(0, maxOutputSize);
        stderr = stderr.substring(0, maxOutputSize);
      }
      
      return {
        entity: context.name,
        platform: 'process',
        success: exitCode === 0,
        execTime,
        command,
        execution: {
          workingDirectory,
          user: requirements.security?.runAsUser 
            ? `uid:${requirements.security.runAsUser}` 
            : process.env.USER || process.env.USERNAME,
          shell,
          interactive: false,
          tty: false,
          exitCode,
          duration,
          environment: undefined
        },
        output: {
          stdout,
          stderr,
          combined: stdout + (stderr ? `\n${stderr}` : ''),
          truncated,
          maxBytes: truncated ? maxOutputSize : undefined
        },
        streaming: {
          supported: false
        },
        security: {
          authenticated: false,
          sudoRequired: command.includes('sudo'),
          audit: false
        },
        error: exitCode !== 0 ? `Command exited with code ${exitCode}` : undefined
      };
      
    } catch (error) {
      return {
        entity: context.name,
        platform: 'process',
        success: false,
        execTime,
        command,
        execution: {
          workingDirectory,
          shell
        },
        error: (error as Error).message
      };
    }
  }
  
  async test(context: ServiceContext, options: TestOptions = {}): Promise<TestResult> {
    const requirements = context.getRequirements();
    const testTime = new Date();
    const startTime = Date.now();
    const servicePath = path.join(context.projectRoot, 'apps', context.name);
    
    // Check if service directory exists
    if (!fs.existsSync(servicePath)) {
      return {
        entity: context.name,
        platform: 'process',
        success: false,
        testTime,
        suite: options.suite || 'unit',
        error: `Service directory does not exist: ${servicePath}`
      };
    }
    
    // Build environment variables from requirements
    const env = {
      ...process.env,
      ...context.getEnvironmentVariables(),
      ...(requirements.environment || {}),
      NODE_ENV: 'test',
      CI: 'true',
      SERVICE_NAME: context.name
    };
    
    // Detect test framework and build command
    let testCommand = '';
    let framework = 'unknown';
    
    // Check for test command in annotations
    if (requirements.annotations?.['test/command']) {
      testCommand = requirements.annotations['test/command'];
      framework = requirements.annotations['test/framework'] || 'custom';
    } else {
      // Check package.json for test script
      const packageJsonPath = path.join(servicePath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
          
          // Detect framework from dependencies
          if (packageJson.devDependencies?.jest || packageJson.dependencies?.jest) {
            framework = 'jest';
          } else if (packageJson.devDependencies?.mocha || packageJson.dependencies?.mocha) {
            framework = 'mocha';
          } else if (packageJson.devDependencies?.vitest || packageJson.dependencies?.vitest) {
            framework = 'vitest';
          }
          
          // Build test command
          if (packageJson.scripts?.test) {
            testCommand = 'npm test';
          } else if (packageJson.scripts?.[`test:${options.suite}`]) {
            testCommand = `npm run test:${options.suite}`;
          }
        } catch (error) {
          // Couldn't read package.json
        }
      }
      
      // Check for Python tests
      if (!testCommand && fs.existsSync(path.join(servicePath, 'setup.py'))) {
        framework = 'pytest';
        testCommand = 'python -m pytest';
      }
    }
    
    // Fallback to npm test
    if (!testCommand) {
      testCommand = 'npm test';
    }
    
    // Add test options to command
    if (options.coverage && framework === 'jest') {
      testCommand += ' --coverage';
    }
    // Pattern and grep options would be added here if they existed in TestOptions
    if (options.bail) {
      testCommand += framework === 'jest' ? ' --bail' : ' --bail';
    }
    
    if (!context.quiet) {
      printInfo(`Running tests for ${context.name} (process): ${testCommand}`);
    }
    
    try {
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      
      try {
        stdout = execSync(testCommand, {
          cwd: servicePath,
          env,
          encoding: 'utf-8',
          timeout: options.timeout || 300000, // 5 minutes default
          maxBuffer: 1024 * 1024 * 50 // 50MB for test output
        });
      } catch (error: any) {
        exitCode = error.status || 1;
        stdout = error.stdout?.toString() || '';
        stderr = error.stderr?.toString() || '';
      }
      
      const duration = Date.now() - startTime;
      
      // Parse test results from output
      const testResults = this.parseTestOutput(stdout, framework);
      const coverage = options.coverage ? this.parseCoverageOutput(stdout, framework) : undefined;
      const failures = exitCode !== 0 ? this.parseFailures(stdout, framework) : undefined;
      
      // Look for test artifacts to put in metadata
      const testMetadata: any = {};
      
      // Check for coverage report
      const coverageDir = path.join(servicePath, 'coverage');
      if (fs.existsSync(coverageDir)) {
        testMetadata.coverageDir = coverageDir;
      }
      
      // Check for test reports
      const reportsDir = path.join(servicePath, 'test-results');
      if (fs.existsSync(reportsDir)) {
        testMetadata.reportsDir = reportsDir;
      }
      
      return {
        entity: context.name,
        platform: 'process',
        success: exitCode === 0,
        testTime,
        suite: options.suite || 'unit',
        passed: testResults.passed,
        failed: testResults.failed,
        skipped: testResults.skipped,
        duration,
        coverage: coverage ? coverage.lines : undefined,
        error: exitCode !== 0 ? `Tests failed with exit code ${exitCode}` : undefined,
        metadata: {
          ...testMetadata,
          failures,
          environment: {
            framework,
            runner: 'local',
            parallel: false
          },
          command: testCommand,
          exitCode,
          outputLength: stdout.length + stderr.length
        }
      };
      
    } catch (error) {
      return {
        entity: context.name,
        platform: 'process',
        success: false,
        testTime,
        suite: options.suite || 'unit',
        error: (error as Error).message
      };
    }
  }
  
  async restore(context: ServiceContext, backupId: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    const requirements = context.getRequirements();
    const restoreTime = new Date();
    const startTime = Date.now();
    const backupDir = path.join(context.projectRoot, '.semiont', 'backups', context.environment);
    const backupPath = path.join(backupDir, `${backupId}.tar.gz`);
    
    if (!context.quiet) {
      printInfo(`Restoring ${context.name} from backup ${backupId}`);
    }
    
    // Check if backup exists
    if (!fs.existsSync(backupPath)) {
      return {
        entity: context.name,
        platform: 'process',
        success: false,
        restoreTime,
        backupId,
        error: `Backup not found: ${backupId}`
      };
    }
    
    try {
      // Verify checksum if requested
      if (options.verifyChecksum !== false) {
        const checksumFile = `${backupPath}.sha256`;
        if (fs.existsSync(checksumFile)) {
          const expectedChecksum = fs.readFileSync(checksumFile, 'utf-8').trim();
          const actualChecksum = execSync(`shasum -a 256 ${backupPath} | cut -d' ' -f1`, { encoding: 'utf-8' }).trim();
          
          if (expectedChecksum !== actualChecksum) {
            return {
              entity: context.name,
              platform: 'process',
              success: false,
              restoreTime,
              backupId,
              error: 'Backup checksum verification failed',
              validation: {
                checksumVerified: false
              }
            };
          }
        }
      }
      
      // Stop service if requested
      let downtimeStart: Date | undefined;
      if (options.stopService !== false) {
        downtimeStart = new Date();
        
        if (!context.quiet) {
          printWarning(`Stopping ${context.name} service for restore`);
        }
        
        await this.stop(context);
      }
      
      // Create backup of current state before restoring
      const preRestoreBackupId = `pre-restore-${Date.now()}`;
      if (!options.force) {
        if (!context.quiet) {
          printInfo('Creating backup of current state before restore');
        }
        
        await this.backup(context);
      }
      
      // Extract backup
      execSync(`tar -xzf ${backupPath} -C ${context.projectRoot}`, {
        cwd: context.projectRoot
      });
      
      // Start service if requested
      let downtimeEnd: Date | undefined;
      let serviceStarted = false;
      
      if (options.startService !== false && downtimeStart) {
        if (!context.quiet) {
          printInfo(`Starting ${context.name} service after restore`);
        }
        
        try {
          await this.start(context);
          serviceStarted = true;
          downtimeEnd = new Date();
        } catch (startError) {
          printWarning(`Failed to start service after restore: ${startError}`);
        }
      }
      
      // Run health check if service was started
      let healthCheckPassed = false;
      if (serviceStarted && requirements.network?.healthCheckPath) {
        try {
          const checkResult = await this.check(context);
          healthCheckPassed = checkResult.health?.healthy || false;
        } catch {
          // Health check failed
        }
      }
      
      // Run tests if requested
      let testsPassed = false;
      if (!options.skipTests && serviceStarted) {
        try {
          const testResult = await this.test(context, { suite: 'health' });
          testsPassed = testResult.success;
        } catch {
          // Tests failed
        }
      }
      
      const duration = Date.now() - startTime;
      
      return {
        entity: context.name,
        platform: 'process',
        success: true,
        restoreTime,
        backupId,
        restore: {
          source: backupPath,
          destination: context.projectRoot,
          size: fs.statSync(backupPath).size,
          duration
        },
        validation: {
          checksumVerified: options.verifyChecksum !== false,
          dataComplete: true,
          servicesRestarted: serviceStarted,
          healthCheck: healthCheckPassed,
          testsPassed: options.skipTests ? undefined : testsPassed
        },
        rollback: {
          supported: true,
          previousBackupId: preRestoreBackupId,
          command: `semiont restore --service ${context.name} --backup-id ${preRestoreBackupId}`
        },
        downtime: downtimeStart && downtimeEnd ? {
          start: downtimeStart,
          end: downtimeEnd,
          duration: downtimeEnd.getTime() - downtimeStart.getTime(),
          planned: true
        } : undefined,
        metadata: {
          platform: 'process',
          restoreMethod: 'tar extraction',
          preRestoreBackup: preRestoreBackupId
        }
      };
      
    } catch (error) {
      return {
        entity: context.name,
        platform: 'process',
        success: false,
        restoreTime,
        backupId,
        error: (error as Error).message
      };
    }
  }
  
  async collectLogs(context: ServiceContext): Promise<CheckResult['logs']> {
    const requirements = context.getRequirements();
    
    // Check for log path in annotations
    let logPath: string | undefined;
    if (requirements.annotations?.['log/path']) {
      logPath = requirements.annotations['log/path'];
    }
    
    // Try standard log locations
    const logPaths = [
      ...(logPath ? [logPath] : []),
      path.join(context.projectRoot, 'logs', `${context.name}.log`),
      path.join(context.projectRoot, 'apps', context.name, 'logs', 'app.log'),
      `/var/log/${context.name}.log`
    ];
    
    for (const logPath of logPaths) {
      if (fs.existsSync(logPath)) {
        try {
          const logs = execSync(`tail -100 ${logPath}`, { encoding: 'utf-8' })
            .split('\n')
            .filter(line => line.trim());
          
          return {
            recent: logs.slice(-10),
            errors: logs.filter(l => l.match(/\b(error|ERROR|Error)\b/)).length,
            warnings: logs.filter(l => l.match(/\b(warning|WARNING|Warning)\b/)).length
          };
        } catch {
          // Couldn't read log file
        }
      }
    }
    
    // Try journalctl for systemd services
    if (requirements.annotations?.['service/type'] === 'systemd') {
      try {
        const logs = execSync(
          `journalctl -u ${context.name} -n 100 --no-pager`,
          { encoding: 'utf-8' }
        ).split('\n').filter(line => line.trim());
        
        return {
          recent: logs.slice(-10),
          errors: logs.filter(l => l.match(/\b(error|ERROR|Error)\b/)).length,
          warnings: logs.filter(l => l.match(/\b(warning|WARNING|Warning)\b/)).length
        };
      } catch {
        // Not a systemd service or no access
      }
    }
    
    return undefined;
  }
  
  /**
   * Parse test output to extract results
   */
  private parseTestOutput(output: string, framework: string): any {
    const results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0
    };
    
    // Jest output parsing
    if (framework === 'jest') {
      const match = output.match(/Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed,\s+(\d+)\s+total/);
      if (match) {
        results.failed = parseInt(match[1]);
        results.passed = parseInt(match[2]);
        results.total = parseInt(match[3]);
      }
    }
    
    // Mocha output parsing
    else if (framework === 'mocha') {
      const passMatch = output.match(/(\d+)\s+passing/);
      const failMatch = output.match(/(\d+)\s+failing/);
      const skipMatch = output.match(/(\d+)\s+pending/);
      
      if (passMatch) results.passed = parseInt(passMatch[1]);
      if (failMatch) results.failed = parseInt(failMatch[1]);
      if (skipMatch) results.skipped = parseInt(skipMatch[1]);
      results.total = results.passed + results.failed + results.skipped;
    }
    
    // Pytest output parsing
    else if (framework === 'pytest') {
      const match = output.match(/(\d+) passed(?:, (\d+) failed)?(?:, (\d+) skipped)?/);
      if (match) {
        results.passed = parseInt(match[1]);
        results.failed = parseInt(match[2] || '0');
        results.skipped = parseInt(match[3] || '0');
        results.total = results.passed + results.failed + results.skipped;
      }
    }
    
    // Generic parsing fallback
    else {
      const passMatch = output.match(/(\d+)\s+pass/i);
      const failMatch = output.match(/(\d+)\s+fail/i);
      
      if (passMatch) results.passed = parseInt(passMatch[1]);
      if (failMatch) results.failed = parseInt(failMatch[1]);
      results.total = results.passed + results.failed;
    }
    
    return results;
  }
  
  /**
   * Parse coverage output
   */
  private parseCoverageOutput(output: string, framework: string): any {
    const coverage: any = {};
    
    // Jest coverage parsing
    if (framework === 'jest') {
      const match = output.match(/Lines\s+:\s+([\d.]+)%.*?Branches\s+:\s+([\d.]+)%.*?Functions\s+:\s+([\d.]+)%.*?Statements\s+:\s+([\d.]+)%/s);
      if (match) {
        coverage.lines = parseFloat(match[1]);
        coverage.branches = parseFloat(match[2]);
        coverage.functions = parseFloat(match[3]);
        coverage.statements = parseFloat(match[4]);
      }
    }
    
    // Pytest coverage parsing
    else if (framework === 'pytest') {
      const match = output.match(/TOTAL\s+\d+\s+\d+\s+([\d.]+)%/);
      if (match) {
        coverage.lines = parseFloat(match[1]);
      }
    }
    
    return Object.keys(coverage).length > 0 ? coverage : undefined;
  }
  
  /**
   * Parse test failures
   */
  private parseFailures(output: string, _framework: string): any[] {
    const failures: any[] = [];
    
    // Basic failure extraction
    const failureRegex = /✕\s+(.+?)(?:\s+\([\d.]+\s*ms\))?$/gm;
    let match;
    
    while ((match = failureRegex.exec(output)) !== null) {
      failures.push({
        test: match[1],
        suite: 'unknown',
        error: 'Test failed'
      });
      
      if (failures.length >= 10) break; // Limit to 10 failures
    }
    
    return failures;
  }
  
  /**
   * Find process ID by port number
   */
  private findProcessByPort(port: number): number | undefined {
    try {
      const output = process.platform === 'darwin'
        ? execSync(`lsof -ti:${port}`, { encoding: 'utf-8' })
        : execSync(`fuser ${port}/tcp 2>/dev/null | awk '{print $2}'`, { encoding: 'utf-8' });
      
      const pid = parseInt(output.trim());
      return isNaN(pid) ? undefined : pid;
    } catch {
      return undefined;
    }
  }
  
  /**
   * Manage secrets using .env files
   */
  override async manageSecret(
    action: 'get' | 'set' | 'list' | 'delete',
    secretPath: string,
    value?: any,
    options?: import('./platform-strategy.js').SecretOptions
  ): Promise<import('./platform-strategy.js').SecretResult> {
    const envFile = path.join(
      process.cwd(),
      `.env${options?.environment ? `.${options.environment}` : ''}`
    );
    
    try {
      switch (action) {
        case 'get': {
          if (!fs.existsSync(envFile)) {
            return {
              success: false,
              action,
              secretPath,
              platform: 'process',
              storage: 'env-file',
              error: `Environment file not found: ${envFile}`
            };
          }
          
          const content = fs.readFileSync(envFile, 'utf-8');
          const envVars = this.parseEnvFile(content);
          const envKey = this.secretPathToEnvKey(secretPath);
          
          if (!(envKey in envVars)) {
            return {
              success: false,
              action,
              secretPath,
              platform: 'process',
              storage: 'env-file',
              error: `Secret not found: ${secretPath}`
            };
          }
          
          return {
            success: true,
            action,
            secretPath,
            value: envVars[envKey],
            platform: 'process',
            storage: 'env-file'
          };
        }
        
        case 'set': {
          const envKey = this.secretPathToEnvKey(secretPath);
          const envValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
          
          let content = '';
          let envVars: Record<string, string> = {};
          
          if (fs.existsSync(envFile)) {
            content = fs.readFileSync(envFile, 'utf-8');
            envVars = this.parseEnvFile(content);
          }
          
          // Update or add the variable
          envVars[envKey] = envValue;
          
          // Rebuild the file content
          const newContent = Object.entries(envVars)
            .map(([key, val]) => `${key}=${val}`)
            .join('\n') + '\n';
          
          fs.writeFileSync(envFile, newContent, 'utf-8');
          
          return {
            success: true,
            action,
            secretPath,
            platform: 'process',
            storage: 'env-file',
            metadata: {
              file: envFile,
              key: envKey
            }
          };
        }
        
        case 'list': {
          if (!fs.existsSync(envFile)) {
            return {
              success: true,
              action,
              secretPath,
              values: [],
              platform: 'process',
              storage: 'env-file'
            };
          }
          
          const content = fs.readFileSync(envFile, 'utf-8');
          const envVars = this.parseEnvFile(content);
          const prefix = this.secretPathToEnvKey(secretPath);
          
          const matchingKeys = Object.keys(envVars)
            .filter(key => key.startsWith(prefix))
            .map(key => this.envKeyToSecretPath(key));
          
          return {
            success: true,
            action,
            secretPath,
            values: matchingKeys,
            platform: 'process',
            storage: 'env-file'
          };
        }
        
        case 'delete': {
          if (!fs.existsSync(envFile)) {
            return {
              success: true,
              action,
              secretPath,
              platform: 'process',
              storage: 'env-file'
            };
          }
          
          const content = fs.readFileSync(envFile, 'utf-8');
          const envVars = this.parseEnvFile(content);
          const envKey = this.secretPathToEnvKey(secretPath);
          
          if (envKey in envVars) {
            delete envVars[envKey];
            
            const newContent = Object.entries(envVars)
              .map(([key, val]) => `${key}=${val}`)
              .join('\n') + '\n';
            
            fs.writeFileSync(envFile, newContent, 'utf-8');
          }
          
          return {
            success: true,
            action,
            secretPath,
            platform: 'process',
            storage: 'env-file'
          };
        }
        
        default:
          return {
            success: false,
            action,
            secretPath,
            platform: 'process',
            error: `Unknown action: ${action}`
          };
      }
    } catch (error) {
      return {
        success: false,
        action,
        secretPath,
        platform: 'process',
        storage: 'env-file',
        error: (error as Error).message
      };
    }
  }
  
  /**
   * Parse .env file content into key-value pairs
   */
  private parseEnvFile(content: string): Record<string, string> {
    const envVars: Record<string, string> = {};
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const equalIndex = trimmed.indexOf('=');
      if (equalIndex === -1) continue;
      
      const key = trimmed.substring(0, equalIndex).trim();
      const value = trimmed.substring(equalIndex + 1).trim();
      
      // Remove quotes if present
      envVars[key] = value.replace(/^["']|["']$/g, '');
    }
    
    return envVars;
  }
  
  /**
   * Convert secret path to environment variable key
   * e.g., "oauth/google/client_id" -> "OAUTH_GOOGLE_CLIENT_ID"
   */
  private secretPathToEnvKey(secretPath: string): string {
    return secretPath
      .toUpperCase()
      .replace(/[\/\-\.]/g, '_')
      .replace(/[^A-Z0-9_]/g, '');
  }
  
  /**
   * Convert environment variable key back to secret path
   * e.g., "OAUTH_GOOGLE_CLIENT_ID" -> "oauth/google/client_id"
   */
  private envKeyToSecretPath(envKey: string): string {
    return envKey.toLowerCase().replace(/_/g, '/');
  }
  
  /**
   * Check if a process is running by PID
   */
  private isProcessRunning(pid: number): boolean {
    try {
      // On Unix-like systems, kill -0 checks if process exists without killing it
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      // ESRCH means "No such process"
      return error.code !== 'ESRCH';
    }
  }
  
  /**
   * Quick check if a service is running using saved state
   * This is faster than doing a full check() call
   */
  override async quickCheckRunning(state: import('../services/state-manager.js').ServiceState): Promise<boolean> {
    if (!state.resources || state.resources.platform !== 'process') {
      return false;
    }
    
    const pid = state.resources.data.pid;
    if (!pid) {
      return false;
    }
    
    return this.isProcessRunning(pid);
  }
}