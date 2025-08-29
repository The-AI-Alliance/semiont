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
      SEMIONT_ENV: this.config.environment || 'development',
      SEMIONT_API_URL: this.getApiUrl()
    };
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
  
  private findMCPServer(): string {
    // Get the directory where the CLI is installed
    const cliPath = new URL(import.meta.url).pathname;
    const cliDir = path.dirname(cliPath);
    
    const possiblePaths = [
      // Look for bundled MCP server in CLI dist directory
      path.join(cliDir, 'mcp-server', 'index.js'),
      path.join(cliDir, '..', 'mcp-server', 'index.js'),
      // Development paths (when running from source)
      path.join(this.config.projectRoot || process.cwd(), 'packages/mcp-server/dist/index.js'),
      path.join(this.config.projectRoot || process.cwd(), 'apps/mcp-server/dist/index.js'),
      // Fallback to current directory
      path.join(process.cwd(), 'mcp-server/index.js'),
      'mcp-server'  // Global install
    ];
    
    for (const mcpPath of possiblePaths) {
      if (fs.existsSync(mcpPath)) {
        return mcpPath;
      }
    }
    
    throw new Error(
      'MCP server not found. Please ensure mcp-server is built and bundled with the CLI.\n' +
      'Run: npm run build in the CLI directory'
    );
  }
}