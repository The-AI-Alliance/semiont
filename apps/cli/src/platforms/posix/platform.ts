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

import { execSync } from 'child_process';
import * as path from "path";
import * as fs from 'fs';
import * as os from 'os';
import { printInfo, printSuccess, printWarning } from '../../core/io/cli-logger.js';
import { BasePlatformStrategy } from '../../core/platform-strategy.js';
import { Service } from '../../services/types.js';
import type { ProvisionResult } from '../../core/command-types.js';
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