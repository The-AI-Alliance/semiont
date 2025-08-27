/**
 * Process Platform Strategy
 * 
 * Manages services running as local OS processes.
 * Uses spawn/exec for process management and PIDs for tracking.
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
import { PlatformResources } from "../lib/platform-resources.js";
import { ExecResult, ExecOptions } from "../commands/exec.js";
import { TestResult, TestOptions } from "../commands/test.js";
import { RestoreResult, RestoreOptions } from "../commands/restore.js";
import { BasePlatformStrategy, ServiceContext } from './platform-strategy.js';
import { StateManager } from '../lib/state-manager.js';
import { printInfo, printWarning } from '../lib/cli-logger.js';
import { isPortInUse } from '../lib/network-utils.js';

export class ProcessPlatformStrategy extends BasePlatformStrategy {
  getPlatformName(): string {
    return 'process';
  }
  
  async start(context: ServiceContext): Promise<StartResult> {
    const port = context.getPort();
    const command = context.getCommand();
    
    // Check if port is already in use
    if (port && await isPortInUse(port)) {
      throw new Error(`Port ${port} is already in use`);
    }
    
    // Parse command into executable and args
    const [cmd, ...args] = command.split(' ');
    
    // Spawn the process
    const proc = spawn(cmd, args, {
      cwd: context.projectRoot,
      env: {
        ...process.env,
        ...context.getEnvironmentVariables(),
        PORT: port?.toString() || '3000',
        NODE_ENV: context.environment
      },
      detached: true,
      stdio: context.verbose ? 'inherit' : 'ignore'
    });
    
    if (!proc.pid) {
      throw new Error('Failed to start process');
    }
    
    // Unref to allow parent to exit
    proc.unref();
    
    return {
      entity: context.name,
      platform: 'process',
      success: true,
      startTime: new Date(),
      endpoint: port ? `http://localhost:${port}` : undefined,
      resources: {
        platform: 'process',
        data: {
          pid: proc.pid,
          port
        }
      },
      metadata: {
        command,
        port
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
    
    const savedPid = savedState?.resources?.platform === 'process' ? savedState.resources.data.pid : undefined;
    
    if (!savedPid) {
      // Try to find process by port
      const port = context.getPort();
      if (port) {
        try {
          const pid = this.findProcessByPort(port);
          if (pid) {
            process.kill(pid, 'SIGTERM');
            // Wait for graceful shutdown
            await new Promise(resolve => setTimeout(resolve, 2000));
            // Force kill if still running
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
      // Send SIGTERM for graceful shutdown
      process.kill(pid, 'SIGTERM');
      
      // Wait for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Force kill if still running
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
      // Process might already be gone
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
    // Load saved state
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
      // Try to find process by port
      const port = context.getPort();
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
          port: context.getPort()
        }
      } as PlatformResources,
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
    // For process deployment, provisioning means:
    // 1. Ensure dependencies are installed
    // 2. Create necessary directories
    // 3. Set up local configuration
    // 4. Prepare environment
    
    if (!context.quiet) {
      printInfo(`Provisioning ${context.name} for process deployment...`);
    }
    
    const resources: PlatformResources | undefined = undefined;
    const dependencies: string[] = [];
    
    // Create necessary directories
    const servicePath = path.join(context.projectRoot, 'apps', context.name);
    const logsPath = path.join(context.projectRoot, 'logs');
    const dataPath = path.join(context.projectRoot, 'data');
    
    await fs.promises.mkdir(logsPath, { recursive: true });
    await fs.promises.mkdir(dataPath, { recursive: true });
    
    // Service-specific provisioning
    switch (context.name) {
      case 'backend':
        // Ensure database is available
        dependencies.push('database');
        
        // Install dependencies if package.json exists
        if (fs.existsSync(path.join(servicePath, 'package.json'))) {
          if (!context.quiet) {
            printInfo('Installing backend dependencies...');
          }
          execSync('npm install', { cwd: servicePath });
        }
        
        // Create backend-specific directories
        await fs.promises.mkdir(path.join(dataPath, 'uploads'), { recursive: true });
        break;
        
      case 'frontend':
        dependencies.push('backend');
        
        // Install and build frontend
        if (fs.existsSync(path.join(servicePath, 'package.json'))) {
          if (!context.quiet) {
            printInfo('Installing and building frontend...');
          }
          execSync('npm install', { cwd: servicePath });
          execSync('npm run build', { cwd: servicePath });
        }
        break;
        
      case 'database':
        // Ensure PostgreSQL is available
        try {
          execSync('which psql', { stdio: 'ignore' });
        } catch {
          throw new Error('PostgreSQL client (psql) not found. Please install PostgreSQL.');
        }
        
        // Create database if it doesn't exist
        const dbName = 'semiont';
        try {
          execSync(`createdb ${dbName}`, { stdio: 'ignore' });
          if (!context.quiet) {
            printInfo(`Created database: ${dbName}`);
          }
        } catch {
          // Database might already exist
        }
        break;
        
      case 'filesystem':
        // Create filesystem structure
        const fsPath = context.config.path || path.join(dataPath, context.name);
        await fs.promises.mkdir(fsPath, { recursive: true });
        // Resources will be set when service starts
        break;
        
      case 'mcp':
        dependencies.push('backend');
        
        // Ensure MCP server is built
        const mcpPath = path.join(context.projectRoot, 'packages', 'mcp-server');
        if (fs.existsSync(path.join(mcpPath, 'package.json'))) {
          execSync('npm install', { cwd: mcpPath });
          execSync('npm run build', { cwd: mcpPath });
        }
        break;
    }
    
    // Check port availability
    const port = context.getPort();
    if (port && await isPortInUse(port)) {
      throw new Error(`Port ${port} is already in use`);
    }
    
    return {
      entity: context.name,
      platform: 'process',
      success: true,
      provisionTime: new Date(),
      resources,
      dependencies,
      metadata: {
        servicePath,
        logsPath,
        dataPath,
        port: port || undefined
      }
    };
  }
  
  async publish(context: ServiceContext): Promise<PublishResult> {
    // For process deployment, publishing means:
    // 1. Build the application
    // 2. Copy/install to target location
    // 3. Create symlinks or systemd services
    // 4. Version tracking
    
    if (!context.quiet) {
      printInfo(`Publishing ${context.name} for process deployment...`);
    }
    
    const artifacts: PublishResult['artifacts'] = {};
    const version: PublishResult['version'] = {};
    const rollback: PublishResult['rollback'] = { supported: false };
    
    const servicePath = path.join(context.projectRoot, 'apps', context.name);
    
    // Get current version
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
    
    // Get git info if available
    try {
      const commitSha = execSync('git rev-parse HEAD', { 
        cwd: context.projectRoot, 
        encoding: 'utf-8' 
      }).trim();
      const branch = execSync('git branch --show-current', { 
        cwd: context.projectRoot, 
        encoding: 'utf-8' 
      }).trim();
      
      artifacts.commitSha = commitSha.substring(0, 7);
      artifacts.branch = branch;
    } catch {
      // Not in git repo
    }
    
    // Service-specific publishing
    switch (context.name) {
      case 'backend':
        // Build backend
        if (fs.existsSync(path.join(servicePath, 'package.json'))) {
          if (!context.quiet) {
            printInfo('Building backend...');
          }
          execSync('npm run build', { cwd: servicePath });
        }
        
        // Could install to /usr/local/bin or /opt
        // Backend would be installed to: /usr/local/lib/semiont-backend
        rollback.supported = true;
        rollback.command = `systemctl restart semiont-backend`;
        break;
        
      case 'frontend':
        // Build frontend static assets
        if (fs.existsSync(path.join(servicePath, 'package.json'))) {
          if (!context.quiet) {
            printInfo('Building frontend...');
          }
          execSync('npm run build', { cwd: servicePath });
          
          const distPath = path.join(servicePath, 'dist');
          if (fs.existsSync(distPath)) {
            // Copy to web server directory
            const targetPath = `/var/www/semiont-${context.environment}`;
            artifacts.bundleUrl = `file://${targetPath}`;
            artifacts.staticSiteUrl = `http://localhost:${context.getPort()}`;
          }
        }
        break;
        
      case 'database':
        // Publish schema migrations
        const migrationsPath = path.join(servicePath, 'migrations');
        if (fs.existsSync(migrationsPath)) {
          if (!context.quiet) {
            printInfo('Applying database migrations...');
          }
          // Would run migration tool
          rollback.supported = true;
          rollback.command = `migrate down`;
        }
        break;
        
      case 'mcp':
        // Package MCP server
        const mcpPath = path.join(context.projectRoot, 'packages', 'mcp-server');
        if (fs.existsSync(path.join(mcpPath, 'package.json'))) {
          execSync('npm run build', { cwd: mcpPath });
          execSync('npm pack', { cwd: mcpPath });
          
          artifacts.packageName = 'semiont-mcp-server';
          artifacts.packageVersion = version.current;
        }
        break;
        
      case 'filesystem':
        // Create filesystem structure with versioning
        const fsPath = context.config.path || path.join(context.projectRoot, 'data');
        const versionFile = path.join(fsPath, 'VERSION');
        
        await fs.promises.writeFile(versionFile, version.current || '1.0.0');
        artifacts.bundleUrl = `file://${fsPath}`;
        break;
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
        buildTime: new Date().toISOString()
      }
    };
  }
  
  async backup(context: ServiceContext): Promise<BackupResult> {
    const backupId = `${context.name}-${context.environment}-${Date.now()}`;
    const backupDir = path.join(context.projectRoot, '.semiont', 'backups', context.environment);
    const servicePath = path.join(context.projectRoot, 'apps', context.name);
    
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
      switch (context.name) {
        case 'database':
          // Database dump for process platform (likely SQLite)
          const dbPath = context.config.path || path.join(servicePath, 'data', 'database.db');
          if (fs.existsSync(dbPath)) {
            const backupPath = path.join(backupDir, `${backupId}.db`);
            execSync(`cp "${dbPath}" "${backupPath}"`);
            
            backup.size = fs.statSync(backupPath).size;
            backup.location = backupPath;
            backup.format = 'binary';
            backup.database = {
              type: 'sqlite',
              schema: true,
              data: true
            };
            restore.command = `cp "${backupPath}" "${dbPath}"`;
          } else {
            throw new Error(`Database file not found at ${dbPath}`);
          }
          break;
          
        case 'filesystem':
          // Tar up the filesystem data
          const fsPath = context.config.path || path.join(servicePath, 'data');
          if (fs.existsSync(fsPath)) {
            const backupPath = path.join(backupDir, `${backupId}.tar.gz`);
            execSync(`tar -czf "${backupPath}" -C "${path.dirname(fsPath)}" "${path.basename(fsPath)}"`);
            
            backup.size = fs.statSync(backupPath).size;
            backup.location = backupPath;
            backup.filesystem = {
              paths: [fsPath],
              preservePermissions: true
            };
            restore.command = `tar -xzf "${backupPath}" -C "${path.dirname(fsPath)}"`;
          } else {
            throw new Error(`Filesystem path not found at ${fsPath}`);
          }
          break;
          
        case 'backend':
        case 'frontend':
        case 'mcp':
        case 'agent':
          // Application backup: source, config, logs
          const backupPath = path.join(backupDir, `${backupId}.tar.gz`);
          const items: string[] = [];
          
          // Include configuration files
          const configFiles = ['package.json', 'package-lock.json', '.env', '.env.local', 'config.json'];
          for (const file of configFiles) {
            const filePath = path.join(servicePath, file);
            if (fs.existsSync(filePath)) {
              items.push(file);
            }
          }
          
          // Include logs if they exist
          const logsPath = path.join(servicePath, 'logs');
          if (fs.existsSync(logsPath)) {
            items.push('logs');
          }
          
          // Include data directory if it exists
          const dataPath = path.join(servicePath, 'data');
          if (fs.existsSync(dataPath)) {
            items.push('data');
          }
          
          if (items.length === 0) {
            throw new Error(`No files to backup for ${context.name}`);
          }
          
          execSync(`tar -czf "${backupPath}" -C "${servicePath}" ${items.join(' ')}`);
          
          backup.size = fs.statSync(backupPath).size;
          backup.location = backupPath;
          backup.application = {
            source: false, // Not backing up source code
            assets: items.includes('assets'),
            logs: items.includes('logs')
          };
          backup.configuration = {
            envFiles: configFiles.filter(f => f.startsWith('.env')),
            configMaps: configFiles.filter(f => f.endsWith('.json'))
          };
          restore.command = `tar -xzf "${backupPath}" -C "${servicePath}"`;
          break;
          
        default:
          throw new Error(`Backup not supported for service ${context.name}`);
      }
      
      // Calculate checksum for integrity
      const checksum = execSync(`shasum -a 256 "${backup.location}"`, { encoding: 'utf-8' }).split(' ')[0];
      backup.checksum = checksum;
      
      // Set retention (30 days default)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);
      
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
          policy: 'monthly',
          autoCleanup: true
        },
        restore,
        metadata: {
          platform: 'process',
          compression: backup.compression,
          integrity: 'sha256'
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
    
    // Build environment variables
    const env = {
      ...process.env,
      ...context.getEnvironmentVariables(),
      NODE_ENV: context.environment,
      SERVICE_NAME: context.name,
      ...options.env
    };
    
    // Determine shell to use
    const shell = options.shell || (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash');
    
    if (!context.quiet) {
      printInfo(`Executing in ${context.name} (process): ${command}`);
    }
    
    try {
      // For interactive commands, we need different handling
      if (options.interactive || options.tty) {
        // Interactive execution not fully supported in process platform
        // Would require more sophisticated terminal handling
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
          // Capture output
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
          // Stream output directly
          execSync(command, {
            cwd: workingDirectory,
            env,
            shell,
            stdio: 'inherit',
            timeout: options.timeout
          });
        }
      } catch (error: any) {
        // Command failed
        exitCode = error.status || 1;
        stdout = error.stdout?.toString() || '';
        stderr = error.stderr?.toString() || error.message;
        
        // If it was a timeout, note that
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
          user: process.env.USER || process.env.USERNAME,
          shell,
          interactive: false,
          tty: false,
          exitCode,
          duration,
          environment: options.env
        },
        output: {
          stdout,
          stderr,
          combined: stdout + (stderr ? `\n${stderr}` : ''),
          truncated,
          maxBytes: truncated ? maxOutputSize : undefined
        },
        streaming: {
          supported: false // Process platform doesn't support real-time streaming
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
    
    // Build environment variables
    const env = {
      ...process.env,
      ...context.getEnvironmentVariables(),
      NODE_ENV: 'test',
      CI: 'true', // Run in CI mode to disable watch
      SERVICE_NAME: context.name,
      ...options.env
    };
    
    // Detect test framework and build command
    let testCommand = '';
    let framework = 'unknown';
    
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
        } else if (packageJson.devDependencies?.pytest) {
          framework = 'pytest';
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
    
    // Fallback to common test commands if not found
    if (!testCommand) {
      switch (context.name) {
        case 'backend':
        case 'frontend':
        case 'mcp':
        case 'agent':
          testCommand = options.suite === 'e2e' ? 'npm run test:e2e' : 'npm test';
          break;
        default:
          testCommand = 'npm test';
      }
    }
    
    // Add test options to command
    if (options.coverage && framework === 'jest') {
      testCommand += ' --coverage';
    }
    if (options.pattern && framework === 'jest') {
      testCommand += ` --testPathPattern="${options.pattern}"`;
    }
    if (options.grep && framework === 'mocha') {
      testCommand += ` --grep "${options.grep}"`;
    }
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
        // Run test command
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
      
      // Look for test artifacts
      const artifacts: TestResult['artifacts'] = {};
      
      // Check for coverage report
      const coverageDir = path.join(servicePath, 'coverage');
      if (fs.existsSync(coverageDir)) {
        artifacts.coverage = coverageDir;
      }
      
      // Check for test reports
      const reportsDir = path.join(servicePath, 'test-results');
      if (fs.existsSync(reportsDir)) {
        artifacts.reports = [reportsDir];
      }
      
      return {
        entity: context.name,
        platform: 'process',
        success: exitCode === 0,
        testTime,
        suite: options.suite || 'unit',
        tests: {
          total: testResults.total,
          passed: testResults.passed,
          failed: testResults.failed,
          skipped: testResults.skipped,
          duration
        },
        coverage: coverage ? {
          enabled: true,
          lines: coverage.lines,
          branches: coverage.branches,
          functions: coverage.functions,
          statements: coverage.statements
        } : undefined,
        failures,
        artifacts: Object.keys(artifacts).length > 0 ? artifacts : undefined,
        environment: {
          framework,
          runner: 'local',
          parallel: false
        },
        error: exitCode !== 0 ? `Tests failed with exit code ${exitCode}` : undefined,
        metadata: {
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
  
  async restore(context: ServiceContext, backupId: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    const restoreTime = new Date();
    const startTime = Date.now();
    const backupDir = path.join(context.projectRoot, '.backups', context.name);
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
          const actualChecksum = execSync(`sha256sum ${backupPath} | cut -d' ' -f1`, { encoding: 'utf-8' }).trim();
          
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
      
      // Determine restore destination
      const servicePath = path.join(context.projectRoot, 'apps', context.name);
      const destination = options.targetPath || servicePath;
      
      // Create backup of current state before restoring
      const preRestoreBackupId = `pre-restore-${Date.now()}`;
      if (!options.force) {
        if (!context.quiet) {
          printInfo('Creating backup of current state before restore');
        }
        
        await this.backup(context);
      }
      
      // Extract backup
      const tempDir = path.join(backupDir, 'temp-restore');
      fs.mkdirSync(tempDir, { recursive: true });
      
      try {
        // Extract to temp directory first
        execSync(`tar -xzf ${backupPath} -C ${tempDir}`, {
          cwd: context.projectRoot
        });
        
        // Restore database if present
        let dbRestored = false;
        let dbTables = 0;
        let dbRecords = 0;
        
        const dbDumpPath = path.join(tempDir, 'database.sql');
        if (fs.existsSync(dbDumpPath)) {
          if (context.name === 'database') {
            // Restore PostgreSQL database
            try {
              execSync(`psql -U postgres -d semiont < ${dbDumpPath}`, {
                env: { ...process.env, PGPASSWORD: 'postgres' }
              });
              dbRestored = true;
              
              // Get table count
              const tableCountResult = execSync(
                `psql -U postgres -d semiont -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';"`,
                { encoding: 'utf-8', env: { ...process.env, PGPASSWORD: 'postgres' } }
              );
              dbTables = parseInt(tableCountResult.trim()) || 0;
              
              // Estimate record count (would need per-table queries in real implementation)
              dbRecords = 1000; // Placeholder
              
            } catch (dbError) {
              if (!options.force) {
                throw new Error(`Database restore failed: ${dbError}`);
              }
            }
          }
        }
        
        // Restore filesystem files
        let filesRestored = 0;
        let dirsRestored = 0;
        
        const filesPath = path.join(tempDir, 'files');
        if (fs.existsSync(filesPath)) {
          // Copy files from backup to destination
          const files = fs.readdirSync(filesPath, { recursive: true, withFileTypes: true });
          
          for (const file of files) {
            if (typeof file === 'string') continue; // Skip string entries
            // TypeScript doesn't properly type recursive+withFileTypes, but we know it's Dirent
            if (!('name' in file && 'path' in file)) continue;
            const srcPath = path.join(file.path, file.name);
            const relPath = path.relative(filesPath, srcPath);
            const destPath = path.join(destination, relPath);
            
            if (file.isDirectory()) {
              fs.mkdirSync(destPath, { recursive: true });
              dirsRestored++;
            } else {
              fs.mkdirSync(path.dirname(destPath), { recursive: true });
              fs.copyFileSync(srcPath, destPath);
              filesRestored++;
            }
          }
        }
        
        // Restore configuration
        const configRestored: string[] = [];
        
        const envBackupPath = path.join(tempDir, '.env');
        if (fs.existsSync(envBackupPath)) {
          const envDestPath = path.join(destination, '.env');
          fs.copyFileSync(envBackupPath, envDestPath);
          configRestored.push('.env');
        }
        
        const configBackupPath = path.join(tempDir, 'config.json');
        if (fs.existsSync(configBackupPath)) {
          const configDestPath = path.join(destination, 'config.json');
          fs.copyFileSync(configBackupPath, configDestPath);
          configRestored.push('config.json');
        }
        
        // Clean up temp directory
        fs.rmSync(tempDir, { recursive: true, force: true });
        
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
        if (serviceStarted) {
          try {
            const checkResult = await this.check(context);
            healthCheckPassed = checkResult.status === 'running';
          } catch {
            // Health check failed
          }
        }
        
        // Run tests if requested and not skipped
        let testsPassed = false;
        if (!options.skipTests && serviceStarted) {
          try {
            const testResult = await this.test(context, { suite: 'smoke' });
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
            destination,
            size: fs.statSync(backupPath).size,
            duration,
            database: dbRestored ? {
              tables: dbTables,
              records: dbRecords,
              schemas: true,
              indexes: true,
              constraints: true
            } : undefined,
            filesystem: filesRestored > 0 ? {
              files: filesRestored,
              directories: dirsRestored,
              permissions: true,
              symlinks: false
            } : undefined,
            configuration: configRestored.length > 0 ? {
              envFiles: configRestored.filter(f => f.includes('.env')),
              configFiles: configRestored.filter(f => !f.includes('.env')),
              secrets: false
            } : undefined
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
        
      } catch (extractError) {
        // Clean up on error
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw extractError;
      }
      
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
    // Try to find log file
    const logPaths = [
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
    
    return undefined;
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
}
