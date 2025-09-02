import * as http from 'http';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';
import { loadEnvironmentConfig } from '../../../core/platform-resolver.js';

/**
 * Provision handler for MCP (Model Context Protocol) services on POSIX systems
 * 
 * Sets up OAuth authentication for MCP service by:
 * 1. Starting a local HTTP server to receive OAuth callback
 * 2. Opening browser for user authentication
 * 3. Saving refresh token for future use
 */
const provisionMCPService = async (context: ProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service } = context;
  
  if (!service.environment) {
    return {
      success: false,
      error: 'Environment must be specified for MCP provisioning',
      metadata: {
        serviceType: 'mcp'
      }
    };
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
  
  return new Promise((resolve, _reject) => {
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
              success: true,
              metadata: {
                serviceType: 'mcp',
                authPath,
                environment: service.environment,
                apiUrl: authData.api_url
              }
            });
          } else {
            resolve({
              success: false,
              error: 'No token received from authentication',
              metadata: {
                serviceType: 'mcp'
              }
            });
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
      resolve({
        success: false,
        error: 'Authentication timeout - please try again',
        metadata: {
          serviceType: 'mcp'
        }
      });
    }, 120000);
  });
};

/**
 * Descriptor for MCP service provision handler
 */
export const mcpProvisionDescriptor: HandlerDescriptor<ProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'posix',
  serviceType: 'mcp',
  handler: provisionMCPService
};