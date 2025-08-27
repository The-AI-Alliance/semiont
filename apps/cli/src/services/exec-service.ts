/**
 * Exec Service Types and Interfaces
 * 
 * Defines the exec operation for services - executing commands
 * within the service context (containers, processes, remote instances).
 */

import type { ServiceName } from './service-interface.js';
import type { Platform } from '../lib/platform-resolver.js';
import type { PlatformResources } from '../lib/platform-resources.js';
/**
 * Result of an exec operation
 */
export interface ExecResult {
  entity: ServiceName | string;
  platform: Platform;
  success: boolean;
  execTime: Date;
  command: string; // The command that was executed
  execution?: {
    // Execution context
    workingDirectory?: string;
    user?: string; // User context (e.g., root, app, www-data)
    shell?: string; // Shell used (bash, sh, etc.)
    interactive?: boolean; // Whether this is an interactive session
    tty?: boolean; // Whether a TTY is allocated
    
    // Process information
    pid?: number; // Process ID of executed command
    exitCode?: number; // Exit code of the command
    signal?: string; // Termination signal if killed
    duration?: number; // Execution time in milliseconds
    
    // Environment
    environment?: Record<string, string>; // Environment variables
    containerId?: string; // For container exec
    instanceId?: string; // For cloud exec (ECS, EC2)
    sessionId?: string; // For SSM or other session-based exec
  };
  output?: {
    stdout?: string; // Standard output
    stderr?: string; // Standard error
    combined?: string; // Combined output (if captured together)
    truncated?: boolean; // Whether output was truncated due to size
    maxBytes?: number; // Maximum bytes captured
  };
  streaming?: {
    supported: boolean; // Can stream output in real-time?
    websocketUrl?: string; // WebSocket URL for streaming
    streamId?: string; // Stream identifier
  };
  security?: {
    authenticated?: boolean; // Whether authentication was required
    authorization?: string; // Authorization method used
    sudoRequired?: boolean; // Did command require sudo?
    audit?: boolean; // Whether execution is audited/logged
  };
  resources?: PlatformResources;  error?: string;
  metadata?: Record<string, any>;
}

/**
 * Options for exec operation
 */
export interface ExecOptions {
  workingDirectory?: string;
  user?: string;
  shell?: string;
  interactive?: boolean;
  tty?: boolean;
  env?: Record<string, string>;
  timeout?: number;
  captureOutput?: boolean;
  stream?: boolean;
}