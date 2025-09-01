/**
 * POSIX Platform Strategy
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
import * as os from 'os';
import { StartResult } from "../../core/commands/start.js";
import { StopResult } from "../../core/commands/stop.js";
import { CheckResult } from "../../core/commands/check.js";
import { UpdateResult } from "../../core/commands/update.js";
import { ProvisionResult } from "../../core/commands/provision.js";
import { PublishResult } from "../../core/commands/publish.js";
import { printInfo, printSuccess, printWarning } from '../../core/io/cli-logger.js';
import { PlatformResources } from "../platform-resources.js";
import { TestResult, TestOptions } from "../../core/commands/test.js";
import { BasePlatformStrategy } from '../../core/platform-strategy.js';
import { Service } from '../../services/types.js';
import { ServiceName } from '../../core/service-discovery.js';
import { StateManager } from '../../core/state-manager.js';
import { isPortInUse } from '../../core/io/network-utils.js';
import { HandlerRegistry } from '../../core/handlers/registry.js';
import { handlers } from './handlers/index.js';

export class PosixPlatformStrategy extends BasePlatformStrategy {
  constructor() {
    super();
    this.registerHandlers();
  }
  
  private registerHandlers(): void {
    const registry = HandlerRegistry.getInstance();
    registry.registerHandlers('posix', handlers);
  }
  
  getPlatformName(): string {
    return 'posix';
  }
  
  async start(service: Service): Promise<StartResult> {
    const requirements = service.getRequirements();
    const command = service.getCommand();
    
    // Check network port availability
    const primaryPort = requirements.network?.ports?.[0];
    if (primaryPort && await isPortInUse(primaryPort)) {
      throw new Error(`Port ${primaryPort} is already in use`);
    }
    
    // Check dependencies are running
    const dependencies = requirements.dependencies?.services || [];
    for (const dep of dependencies) {
      const depState = await StateManager.load(
        service.projectRoot,
        service.environment,
        dep
      );
      
      if (!depState) {
        printWarning(`Dependency '${dep}' has never been started`);
      } else {
        // Verify the dependency is actually running
        let isRunning = false;
        
        // Use the appropriate platform strategy to check if running
        const { PlatformFactory } = await import('../index.js');
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
      ...service.getEnvironmentVariables(),
      ...(requirements.environment || {}),
      NODE_ENV: service.environment
    };
    
    // Add port if specified in network requirements
    if (primaryPort) {
      (env as any).PORT = primaryPort.toString();
    }
    
    // Parse command
    const [cmd, ...args] = command.split(' ');
    
    // Special handling for MCP service - it needs to run interactively with stdio
    if (service.name === 'mcp') {
      const proc = spawn(cmd, args, {
        cwd: process.cwd(),  // Use current directory
        env,
        stdio: 'inherit'  // Connect stdin/stdout for JSON-RPC
      });
      
      if (!proc.pid) {
        throw new Error('Failed to start MCP process');
      }
      
      // Don't detach or unref - MCP needs to keep running
      // The process will handle signals and exit appropriately
      
      // For MCP, we return immediately but the process keeps running
      return {
        entity: service.name,
        platform: 'posix',
        success: true,
        startTime: new Date(),
        metadata: {
          command,
          mode: 'stdio',
          pid: proc.pid
        }
      };
    }
    
    // Regular service spawning (detached)
    // For process platform, run commands in the current directory if we're already in the right place
    // This allows running semiont from a service directory with SEMIONT_ROOT pointing to the project
    const workingDir = process.cwd();
    
    // Determine stdio handling:
    // - quiet: ignore all output
    // - verbose: inherit (show everything)
    // - default: pipe (capture but don't show)
    let stdio: any;
    if (service.quiet) {
      stdio = 'ignore';
    } else if (service.verbose) {
      stdio = 'inherit';
    } else {
      // Default: capture output for logging but don't display
      stdio = ['ignore', 'pipe', 'pipe'];
    }
    
    const proc = spawn(cmd, args, {
      cwd: workingDir,
      env,
      detached: true,
      stdio
    });
    
    if (!proc.pid) {
      throw new Error('Failed to start process');
    }
    
    // If we're piping output, log any errors
    if (Array.isArray(stdio) && stdio[1] === 'pipe' && proc.stdout) {
      proc.stdout.on('data', (data) => {
        // Could write to a log file here if needed
        if (service.verbose) {
          console.log(data.toString());
        }
      });
    }
    
    if (Array.isArray(stdio) && stdio[2] === 'pipe' && proc.stderr) {
      proc.stderr.on('data', (data) => {
        // Always log errors
        console.error(`[${service.name}] ${data.toString()}`);
      });
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
      entity: service.name,
      platform: 'posix',
      success: true,
      startTime: new Date(),
      endpoint,
      resources: {
        platform: 'posix',
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
  
  async stop(service: Service): Promise<StopResult> {
    // Load saved state to get PID
    const savedState = await StateManager.load(
      service.projectRoot,
      service.environment,
      service.name
    );
    
    const savedPid = savedState?.resources?.platform === 'posix' ? 
      savedState.resources.data.pid : undefined;
    
    if (!savedPid) {
      // Try to find process by port from requirements
      const requirements = service.getRequirements();
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
        entity: service.name,
        platform: 'posix',
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
        entity: service.name,
        platform: 'posix',
        success: true,
        stopTime: new Date(),
        gracefulShutdown: true,
        metadata: {
          pid
        }
      };
    } catch (error) {
      return {
        entity: service.name,
        platform: 'posix',
        success: true,
        stopTime: new Date(),
        metadata: {
          message: 'Process already stopped'
        }
      };
    }
  }
  
  async update(service: Service): Promise<UpdateResult> {
    // For process: stop and restart
    const stopResult = await this.stop(service);
    
    // Clear state
    await StateManager.clear(
      service.projectRoot,
      service.environment,
      service.name
    );
    
    // Start new version
    const startResult = await this.start(service);
    
    return {
      entity: service.name,
      platform: 'posix',
      success: true,
      updateTime: new Date(),
      strategy: 'restart',
      metadata: {
        stopped: stopResult.success,
        started: startResult.success
      }
    };
  }
  
  async provision(service: Service): Promise<ProvisionResult> {
    const requirements = service.getRequirements();
    
    // Special handling for MCP service OAuth setup
    if (service.name === 'mcp') {
      return this.provisionMCPOAuth(service);
    }
    
    if (!service.quiet) {
      printInfo(`Provisioning ${service.name} for process deployment...`);
    }
    
    const dependencies = requirements.dependencies?.services || [];
    const metadata: any = {};
    
    // Create base directories
    const logsPath = path.join(service.projectRoot, 'logs');
    const dataPath = path.join(service.projectRoot, 'data');
    
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
            : path.join(dataPath, storage.mountPath || service.name);
          
          await fs.promises.mkdir(storagePath, { recursive: true });
          
          if (!service.quiet) {
            printInfo(`Created storage directory: ${storagePath}`);
          }
          
          metadata[`storage_${storage.volumeName || 'default'}`] = storagePath;
        }
      }
    }
    
    // Install dependencies if build requirements specify it
    if (requirements.build && !requirements.build.prebuilt) {
      const servicePath = path.join(service.projectRoot, 'apps', service.name);
      const buildContext = requirements.build.buildContext || servicePath;
      
      // Check for package.json (Node.js project)
      if (fs.existsSync(path.join(buildContext, 'package.json'))) {
        if (!service.quiet) {
          printInfo(`Installing dependencies for ${service.name}...`);
        }
        execSync('npm install', { cwd: buildContext });
        
        // Build if specified
        if (requirements.build.buildArgs?.BUILD === 'true') {
          if (!service.quiet) {
            printInfo(`Building ${service.name}...`);
          }
          execSync('npm run build', { cwd: buildContext });
        }
      }
      
      // Check for requirements.txt (Python project)
      else if (fs.existsSync(path.join(buildContext, 'requirements.txt'))) {
        if (!service.quiet) {
          printInfo(`Installing Python dependencies for ${service.name}...`);
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
      entity: service.name,
      platform: 'posix',
      success: true,
      provisionTime: new Date(),
      dependencies,
      metadata
    };
  }
  
  async publish(service: Service): Promise<PublishResult> {
    const requirements = service.getRequirements();
    
    if (!service.quiet) {
      printInfo(`Publishing ${service.name} for process deployment...`);
    }
    
    const artifacts: PublishResult['artifacts'] = {};
    const version: PublishResult['version'] = {};
    const rollback: PublishResult['rollback'] = { supported: false };
    
    // Get version from package.json if available
    const servicePath = path.join(service.projectRoot, 'apps', service.name);
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
        cwd: service.projectRoot, 
        encoding: 'utf-8' 
      }).trim();
      artifacts.commitSha = commitSha.substring(0, 7);
      
      const branch = execSync('git branch --show-current', { 
        cwd: service.projectRoot, 
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
        if (!service.quiet) {
          printInfo(`Building ${service.name}...`);
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
        if (!service.quiet) {
          printInfo(`Building Python package for ${service.name}...`);
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
        if (!service.quiet) {
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
      const packagePath = path.join(servicePath, `${service.name}-${version.current}.tar.gz`);
      execSync(`tar -czf ${packagePath} .`, { cwd: servicePath });
      artifacts.bundleUrl = `file://${packagePath}`;
    }
    
    return {
      entity: service.name,
      platform: 'posix',
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
  
  /**
   * Provision MCP OAuth authentication
   * Opens browser for OAuth flow and saves refresh token
   */
  private async provisionMCPOAuth(service: Service): Promise<ProvisionResult> {
    const http = await import('http');
    const { spawn } = await import('child_process');
    const { loadEnvironmentConfig } = await import('../../core/platform-resolver.js');
    
    if (!service.environment) {
      throw new Error('Environment must be specified for MCP provisioning');
    }
    
    const envConfig = loadEnvironmentConfig(service.environment);
    const domain = envConfig.site?.domain || 'localhost:3000';
    const protocol = domain.includes('localhost') ? 'http' : 'https';
    const port = 8585; // Default MCP OAuth callback port
    
    // Create config directory
    const configDir = path.join(os.homedir(), '.config', 'semiont');
    await fs.promises.mkdir(configDir, { recursive: true });
    
    const authPath = path.join(configDir, `mcp-auth-${service.environment}.json`);
    
    if (!service.quiet) {
      printInfo('🔐 Setting up MCP authentication...');
    }
    
    return new Promise((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;
      const connections = new Set<any>();
      
      // Start local HTTP server to receive OAuth callback
      const server = http.createServer((req, res) => {
        const url = new URL(req.url!, `http://localhost:${port}`);
        
        if (url.pathname === '/callback') {
          const token = url.searchParams.get('token');
          
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html>
              <head>
                <meta charset="utf-8">
                <title>Authentication Successful</title>
              </head>
              <body style="font-family: system-ui; padding: 2rem; text-align: center;">
                <h1>✅ Authentication Successful!</h1>
                <p>You can close this window and return to the terminal.</p>
              </body>
            </html>
          `);
          
          // Clear timeout and close server
          clearTimeout(timeoutId);
          
          // Force close all connections
          connections.forEach(conn => conn.destroy());
          server.close(() => {
            if (token) {
              // Save the refresh token
              const authData = {
                refresh_token: token,
                api_url: `${protocol}://${domain}`,
                environment: service.environment,
                created_at: new Date().toISOString()
              };
              
              fs.writeFileSync(authPath, JSON.stringify(authData, null, 2));
              
              if (!service.quiet) {
                printSuccess(`MCP service provisioned for ${service.environment}`);
                printInfo('Add to AI application config:');
                printInfo('Note: Replace SEMIONT_ROOT with your actual project path');
                printInfo('      (Run "semiont init" in that directory if not already initialized)');
                console.log(JSON.stringify({
                  "semiont": {
                    "command": "semiont",
                    "args": ["start", "--service", "mcp", "--environment", service.environment],
                    "env": {
                      "SEMIONT_ROOT": "/PATH/TO/YOUR/SEMIONT/PROJECT",
                      "SEMIONT_ENV": service.environment
                    }
                  }
                }, null, 2));
              }
              
              resolve({
                entity: service.name as ServiceName,
                platform: 'posix',
                success: true,
                provisionTime: new Date(),
                metadata: {
                  authPath,
                  environment: service.environment,
                  apiUrl: authData.api_url
                }
              });
            } else {
              reject(new Error('No token received from authentication'));
            }
          });
        }
      });
      
      // Track connections to force close them
      server.on('connection', (conn) => {
        connections.add(conn);
        conn.on('close', () => connections.delete(conn));
      });
      
      // Listen on the OAuth callback port
      server.listen(port, () => {
        if (!service.quiet) {
          printInfo('Opening browser for authentication...');
        }
        
        const authUrl = `${protocol}://${domain}/auth/mcp-setup?callback=http://localhost:${port}/callback`;
        
        // Open browser using platform-specific command
        const platform = process.platform;
        let openCommand: string;
        if (platform === 'darwin') {
          openCommand = 'open';
        } else if (platform === 'win32') {
          openCommand = 'start';
        } else {
          openCommand = 'xdg-open';
        }
        
        try {
          spawn(openCommand, [authUrl], { detached: true, stdio: 'ignore' }).unref();
        } catch (err) {
          if (!service.quiet) {
            printWarning(`Could not open browser automatically`);
            printInfo(`Please open this URL manually:`);
            printInfo(`  ${authUrl}`);
          }
        }
      });
      
      // Timeout after 2 minutes
      timeoutId = setTimeout(() => {
        connections.forEach(conn => conn.destroy());
        server.close();
        reject(new Error('Authentication timeout - please try again'));
      }, 120000);
    });
  }

  async test(service: Service, options: TestOptions = {}): Promise<TestResult> {
    const requirements = service.getRequirements();
    const testTime = new Date();
    const startTime = Date.now();
    const servicePath = path.join(service.projectRoot, 'apps', service.name);
    
    // Check if service directory exists
    if (!fs.existsSync(servicePath)) {
      return {
        entity: service.name,
        platform: 'posix',
        success: false,
        testTime,
        suite: options.suite || 'unit',
        error: `Service directory does not exist: ${servicePath}`
      };
    }
    
    // Build environment variables from requirements
    const env = {
      ...process.env,
      ...service.getEnvironmentVariables(),
      ...(requirements.environment || {}),
      NODE_ENV: 'test',
      CI: 'true',
      SERVICE_NAME: service.name
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
    
    if (!service.quiet) {
      printInfo(`Running tests for ${service.name} (process): ${testCommand}`);
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
        entity: service.name,
        platform: 'posix',
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
        entity: service.name,
        platform: 'posix',
        success: false,
        testTime,
        suite: options.suite || 'unit',
        error: (error as Error).message
      };
    }
  }
  
  async collectLogs(service: Service): Promise<CheckResult['logs']> {
    const requirements = service.getRequirements();
    
    // Check for log path in annotations
    let logPath: string | undefined;
    if (requirements.annotations?.['log/path']) {
      logPath = requirements.annotations['log/path'];
    }
    
    // Try standard log locations
    const logPaths = [
      ...(logPath ? [logPath] : []),
      path.join(service.projectRoot, 'logs', `${service.name}.log`),
      path.join(service.projectRoot, 'apps', service.name, 'logs', 'app.log'),
      `/var/log/${service.name}.log`
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
          `journalctl -u ${service.name} -n 100 --no-pager`,
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
    options?: import('../../core/platform-strategy.js').SecretOptions
  ): Promise<import('../../core/platform-strategy.js').SecretResult> {
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
              platform: 'posix',
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
              platform: 'posix',
              storage: 'env-file',
              error: `Secret not found: ${secretPath}`
            };
          }
          
          return {
            success: true,
            action,
            secretPath,
            value: envVars[envKey],
            platform: 'posix',
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
            platform: 'posix',
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
              platform: 'posix',
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
            platform: 'posix',
            storage: 'env-file'
          };
        }
        
        case 'delete': {
          if (!fs.existsSync(envFile)) {
            return {
              success: true,
              action,
              secretPath,
              platform: 'posix',
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
            platform: 'posix',
            storage: 'env-file'
          };
        }
        
        default:
          return {
            success: false,
            action,
            secretPath,
            platform: 'posix',
            error: `Unknown action: ${action}`
          };
      }
    } catch (error) {
      return {
        success: false,
        action,
        secretPath,
        platform: 'posix',
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
  override async quickCheckRunning(state: import('../../core/state-manager.js').ServiceState): Promise<boolean> {
    if (!state.resources || state.resources.platform !== 'posix') {
      return false;
    }
    
    const pid = state.resources.data.pid;
    if (!pid) {
      return false;
    }
    
    return this.isProcessRunning(pid);
  }
  
  /**
   * Determine service type for handler selection
   */
  determineServiceType(service: Service): string {
    const requirements = service.getRequirements();
    const serviceName = service.name.toLowerCase();
    
    // Check for MCP services
    if (service.name === ServiceName.MCP || 
        requirements.annotations?.['service/type'] === 'mcp') {
      return 'mcp';
    }
    
    // Check for database services
    if (requirements.annotations?.['service/type'] === 'database' ||
        serviceName.includes('postgres') || 
        serviceName.includes('mysql') || 
        serviceName.includes('mongodb') ||
        serviceName.includes('redis')) {
      return 'database';
    }
    
    // Check for web services
    if (requirements.network?.healthCheckPath ||
        requirements.annotations?.['service/type'] === 'web') {
      return 'web';
    }
    
    // Check for filesystem services
    if (requirements.annotations?.['service/type'] === 'filesystem' ||
        serviceName.includes('nfs') ||
        serviceName.includes('samba') ||
        serviceName.includes('webdav')) {
      return 'filesystem';
    }
    
    // Default to worker for everything else
    return 'worker';
  }
  
  /**
   * Build platform-specific context extensions for handlers
   */
  async buildHandlerContextExtensions(service: Service, requiresDiscovery: boolean): Promise<Record<string, any>> {
    // Load saved state for posix handlers
    const savedState = await StateManager.load(
      service.projectRoot,
      service.environment,
      service.name
    );
    
    return {
      savedState
    };
  }
}