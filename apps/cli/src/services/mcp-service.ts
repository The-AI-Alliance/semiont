import { BaseService } from './base-service.js';
import { StartResult } from './types.js';
import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { loadEnvironmentConfig } from '../lib/deployment-resolver.js';
import { printInfo, printError } from '../lib/cli-logger.js';

export class MCPService extends BaseService {
  protected async preStart(): Promise<void> {
    // MCP requires environment to be set
    if (!this.config.environment) {
      throw new Error('Environment must be specified for MCP service');
    }
    
    // MCP only works as process deployment
    if (this.deployment !== 'process') {
      throw new Error(`MCP service only supports process deployment, got: ${this.deployment}`);
    }
  }
  
  protected async doStart(): Promise<StartResult> {
    // Load environment config
    const envConfig = loadEnvironmentConfig(this.config.environment);
    const apiUrl = `https://${envConfig.site.domain}`;
    
    // Check for provisioned auth
    const authPath = path.join(os.homedir(), '.config', 'semiont', `mcp-auth-${this.config.environment}.json`);
    
    if (!fs.existsSync(authPath)) {
      throw new Error(
        `MCP not provisioned for ${this.config.environment}. ` +
        `Run: semiont provision --service mcp --environment ${this.config.environment}`
      );
    }
    
    try {
      // Load stored refresh token
      const authData = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      
      // Get fresh access token from backend
      const response = await fetch(`${apiUrl}/api/tokens/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: authData.refresh_token })
      });
      
      if (!response.ok) {
        throw new Error('Failed to refresh access token. You may need to re-provision.');
      }
      
      const { access_token } = await response.json();
      
      // Find MCP server executable
      const mcpServerPath = this.findMCPServer();
      
      // Spawn MCP server
      const mcpProc = spawn('node', [mcpServerPath], {
        stdio: 'inherit',
        env: {
          ...process.env,
          SEMIONT_API_URL: apiUrl,
          SEMIONT_API_TOKEN: access_token
        }
      });
      
      // Handle errors
      mcpProc.on('error', (err) => {
        if (!this.config.quiet) {
          printError(`Failed to start MCP server: ${err}`);
        }
        process.exit(1);
      });
      
      if (this.config.quiet) {
        // MCP server takes over stdio completely
        mcpProc.on('exit', (code) => {
          process.exit(code || 0);
        });
        
        // Return a promise that never resolves (will exit via process.exit)
        return new Promise(() => {});
      }
      
      return {
        service: this.name,
        deployment: this.deployment,
        success: true,
        startTime: new Date(),
        endpoint: 'stdio://localhost',
        pid: mcpProc.pid,
        metadata: {
          environment: this.config.environment,
          apiUrl,
          authPath,
          pid: mcpProc.pid
        }
      };
      
    } catch (error: any) {
      throw new Error(`Failed to start MCP server: ${error.message}`);
    }
  }
  
  private findMCPServer(): string {
    const possiblePaths = [
      // Bundled with CLI in dist/mcp-server
      path.join(this.config.projectRoot, 'apps', 'cli', 'dist', 'mcp-server', 'index.js'),
      // In source repo  
      path.join(this.config.projectRoot, 'packages', 'mcp-server', 'dist', 'index.js'),
      // Alternative bundled location
      path.join(this.config.projectRoot, 'dist', 'mcp-server', 'index.js'),
    ];
    
    if (this.config.verbose) {
      printInfo('MCP server search paths:');
      possiblePaths.forEach((p, i) => {
        console.error(`  ${i + 1}. ${p} (${fs.existsSync(p) ? 'exists' : 'not found'})`);
      });
    }
    
    const mcpServerPath = possiblePaths.find(p => fs.existsSync(p));
    
    if (!mcpServerPath) {
      console.error('ERROR: MCP server not found in any of these locations:');
      possiblePaths.forEach((p, i) => {
        console.error(`  ${i + 1}. ${p}`);
      });
      throw new Error('MCP server not found. Run: npm run install:cli');
    }
    
    if (this.config.verbose) {
      printInfo(`Using MCP server at: ${mcpServerPath}`);
    }
    
    return mcpServerPath;
  }
}