import { spawn } from 'child_process';
import { StartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { PlatformResources } from '../../platform-resources.js';

/**
 * Start handler for MCP (Model Context Protocol) services on POSIX systems
 * 
 * MCP is a special service that needs to run interactively with stdio for JSON-RPC communication.
 * It runs as a blocking process that inherits stdin/stdout to communicate with MCP clients.
 */
const startMCPService = async (context: StartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const command = service.getCommand();
  
  // Build environment from service configuration
  const env = {
    ...process.env,
    ...service.getEnvironmentVariables(),
    NODE_ENV: service.environment
  };
  
  // Parse command
  const [cmd, ...args] = command.split(' ');
  
  // MCP service needs special handling - it runs interactively with stdio
  const proc = spawn(cmd, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit'  // Connect stdin/stdout for JSON-RPC communication
  });
  
  if (!proc.pid) {
    return {
      success: false,
      error: 'Failed to start MCP process',
      metadata: {
        serviceType: 'mcp',
        command
      }
    };
  }
  
  // Don't detach or unref - MCP needs to keep running as a blocking process
  // The process will handle signals and exit appropriately
  
  const resources: PlatformResources = {
    platform: 'posix',
    data: {
      pid: proc.pid,
      command
    }
  };
  
  // For MCP, we return immediately but the process keeps running
  return {
    success: true,
    resources,
    metadata: {
      serviceType: 'mcp',
      command,
      mode: 'stdio',
      pid: proc.pid,
      note: 'MCP server running in interactive stdio mode for JSON-RPC communication'
    }
  };
};

/**
 * Descriptor for MCP service start handler
 */
export const mcpStartDescriptor: HandlerDescriptor<StartHandlerContext, StartHandlerResult> = {
  command: 'start',
  serviceType: 'mcp',
  handler: startMCPService
};