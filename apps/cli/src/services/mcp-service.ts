/**
 * MCP Service
 * 
 * Model Context Protocol (MCP) server that exposes the Semiont API
 * to any MCP-compatible client. This service makes Semiont's capabilities
 * available wherever MCP is spoken, enabling integration with AI assistants
 * and other MCP-aware systems.
 * 
 * Current Capabilities:
 * - "hello" service for basic connectivity testing
 * - Foundation for future API expansion
 * 
 * Planned Features:
 * - Graph retrieval for GraphRAG-like systems
 * - Service orchestration APIs
 * - Infrastructure query and management
 * - Knowledge graph traversal
 * 
 * Default Requirements:
 * - Compute: 512MB RAM, 0.5 CPU cores
 * - Network: Uses stdio or HTTP transport
 * - Storage: Minimal, mainly for configuration
 * - Security: Controlled access to Semiont APIs
 * 
 * Platform Adaptations:
 * - Process: Runs as stdio server for local MCP clients
 * - Container: Isolated MCP endpoint with defined API surface
 * - AWS: Lambda functions for serverless MCP API
 * - External: Bridges to existing MCP infrastructures
 * 
 * Acts as the MCP gateway to Semiont, translating MCP requests
 * into Semiont operations and exposing Semiont's knowledge graph
 * and service management capabilities through the MCP protocol.
 */

import { BaseService } from './base-service.js';
import { ServiceRequirements, RequirementPresets } from '../services/service-requirements.js';
import { CheckResult } from '../commands/check.js';
import { loadEnvironmentConfig } from '../platforms/platform-resolver.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export class MCPService extends BaseService {
  
  // =====================================================================
  // Service Requirements
  // =====================================================================
  
  override getRequirements(): ServiceRequirements {
    // MCP service acts like a background worker/API
    return RequirementPresets.backgroundWorker();
  }
  
  // =====================================================================
  // Service-specific configuration
  // =====================================================================
  
  override getPort(): number {
    return 0; // MCP uses stdio, not ports
  }
  
  override getHealthEndpoint(): string {
    return ''; // MCP doesn't have HTTP endpoints
  }
  
  override getCommand(): string {
    const mcpServerPath = this.findMCPServer();
    return this.config.command || `node ${mcpServerPath}`;
  }
  
  override getImage(): string {
    return ''; // MCP only runs as process
  }
  
  override getEnvironmentVariables(): Record<string, string> {
    const baseEnv = super.getEnvironmentVariables();
    
    return {
      ...baseEnv,
      SEMIONT_API_URL: this.getApiUrl(),
      SEMIONT_API_TOKEN: this.getApiToken()
    };
  }
  
  // =====================================================================
  // Service-specific hooks
  // =====================================================================
  
  protected override async preStart(): Promise<void> {
    // MCP requires environment to be set
    if (!this.config.environment) {
      throw new Error('Environment must be specified for MCP service');
    }
    
    // MCP only works as process deployment
    if (this.platform !== 'process') {
      throw new Error(`MCP service only supports process deployment, got: ${this.platform}`);
    }
    
    // Check for provisioned auth
    const authPath = this.getAuthPath();
    if (!fs.existsSync(authPath)) {
      throw new Error(
        `MCP not provisioned for ${this.config.environment}. ` +
        `Run: semiont provision --service mcp --environment ${this.config.environment}`
      );
    }
    
    // Load and refresh token
    try {
      const authData = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      const apiUrl = this.getApiUrl();
      
      // Get fresh access token from backend
      const response = await fetch(`${apiUrl}/api/tokens/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: authData.refresh_token })
      });
      
      if (!response.ok) {
        throw new Error('Failed to refresh access token. You may need to re-provision.');
      }
      
      const { access_token } = await response.json() as { access_token: string };
      
      // Store the token in environment for the process
      process.env.SEMIONT_API_TOKEN = access_token;
    } catch (error) {
      throw new Error(`Failed to authenticate MCP: ${error}`);
    }
  }
  
  protected override async checkHealth(): Promise<CheckResult['health']> {
    // MCP runs on stdio, hard to health check
    return {
      healthy: true,
      details: { 
        message: 'MCP server communication via stdio',
        endpoint: 'stdio://localhost'
      }
    };
  }
  
  // =====================================================================
  // Helper methods
  // =====================================================================
  
  private getApiUrl(): string {
    const envConfig = loadEnvironmentConfig(this.config.environment);
    return `https://${envConfig.site?.domain || 'localhost'}`;
  }
  
  private getApiToken(): string {
    return process.env.SEMIONT_API_TOKEN || '';
  }
  
  private getAuthPath(): string {
    return path.join(os.homedir(), '.config', 'semiont', `mcp-auth-${this.config.environment}.json`);
  }
  
  private findMCPServer(): string {
    const possiblePaths = [
      path.join(this.config.projectRoot, 'apps/mcp-server/dist/index.js'),
      path.join(this.config.projectRoot, 'apps/mcp-server/index.js'),
      path.join(this.config.projectRoot, 'mcp-server/index.js'),
      path.join(process.cwd(), 'mcp-server/index.js'),
      'mcp-server'  // Global install
    ];
    
    for (const mcpPath of possiblePaths) {
      if (fs.existsSync(mcpPath)) {
        return mcpPath;
      }
    }
    
    throw new Error(
      'MCP server not found. Please ensure mcp-server is built or installed.\n' +
      'Run: npm run build:mcp'
    );
  }
}