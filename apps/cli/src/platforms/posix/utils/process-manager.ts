import { execSync } from 'child_process';
import { printInfo, printWarning } from '../../../core/io/cli-logger.js';

/**
 * Service-specific process cleanup patterns
 */
export interface ServiceCleanupPatterns {
  /** Service type identifier */
  serviceType: 'backend' | 'frontend';
  /** Process patterns to kill */
  patterns: string[];
}

/**
 * Default cleanup patterns for known service types
 */
const DEFAULT_CLEANUP_PATTERNS: Record<string, ServiceCleanupPatterns> = {
  backend: {
    serviceType: 'backend',
    patterns: [
      'tsc.*watch',           // TypeScript watch processes
      'node.*watch.*dist/index', // Node.js watch processes
      'npm.*dev.*backend'     // npm dev processes
    ]
  },
  frontend: {
    serviceType: 'frontend', 
    patterns: [
      'next.*dev',            // Next.js dev server
      'npm.*dev.*frontend',   // npm dev processes
      'node.*next.*dev',      // Next.js child processes
      'webpack.*hot.*reload'  // Webpack HMR processes
    ]
  }
};

/**
 * Helper function to kill process groups and related development processes
 * 
 * @param pid - The main process ID to kill
 * @param serviceType - Type of service for targeted cleanup
 * @param verbose - Whether to output verbose logging
 * @returns Whether the process was successfully killed
 */
export async function killProcessGroupAndRelated(
  pid: number,
  serviceType: 'backend' | 'frontend',
  verbose: boolean = false
): Promise<boolean> {
  let killed = false;
  
  try {
    // First, try to kill the process group (-pid kills the entire process group)
    if (verbose) {
      printInfo(`Killing process group for PID ${pid}...`);
    }
    process.kill(-pid, 'SIGTERM');
    killed = true;
    
    // Wait a moment for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Check if main process still exists
    try {
      process.kill(pid, 0);
      // Still exists, force kill the group
      if (verbose) {
        printWarning(`Process group didn't terminate gracefully, force killing...`);
      }
      process.kill(-pid, 'SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch {
      // Main process is gone, good
    }
  } catch (error) {
    if (verbose) {
      printWarning(`Could not kill process group: ${error}`);
    }
    
    // Fallback: kill just the main process
    try {
      process.kill(pid, 'SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      try {
        process.kill(pid, 0);
        // Still exists, force kill
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process is gone
      }
      killed = true;
    } catch {
      // Process already gone
    }
  }
  
  // Clean up any orphaned service-related processes
  const cleanupPatterns = DEFAULT_CLEANUP_PATTERNS[serviceType];
  if (cleanupPatterns) {
    try {
      for (const pattern of cleanupPatterns.patterns) {
        execSync(`pkill -f "${pattern}" || true`, { stdio: 'ignore' });
      }
      
      if (verbose) {
        printInfo(`Cleaned up any orphaned ${serviceType} development processes`);
      }
    } catch {
      // Cleanup is best-effort
    }
  }
  
  return killed;
}

/**
 * Check if a process is running
 * 
 * @param pid - Process ID to check
 * @returns Whether the process is running
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gracefully stop a process with timeout
 * 
 * @param pid - Process ID to stop
 * @param maxWaitTime - Maximum time to wait for graceful shutdown (ms)
 * @param checkInterval - Interval to check if process is still running (ms)
 * @param verbose - Whether to output verbose logging
 * @returns Whether the process terminated gracefully
 */
export async function gracefulStop(
  pid: number,
  maxWaitTime: number = 10000,
  checkInterval: number = 500,
  verbose: boolean = false
): Promise<boolean> {
  // Send SIGTERM for graceful shutdown
  process.kill(pid, 'SIGTERM');
  
  // Wait for process to terminate
  let terminated = false;
  let waitTime = 0;
  
  while (waitTime < maxWaitTime) {
    await new Promise(resolve => setTimeout(resolve, checkInterval));
    waitTime += checkInterval;
    
    if (!isProcessRunning(pid)) {
      terminated = true;
      break;
    }
    
    if (verbose && waitTime % 2000 === 0) {
      printInfo(`Waiting for process to shut down... (${waitTime / 1000}s)`);
    }
  }
  
  if (!terminated) {
    // Force kill if not terminated gracefully
    if (verbose) {
      printWarning('Process did not terminate gracefully, forcing shutdown...');
    }
    
    process.kill(pid, 'SIGKILL');
    
    // Wait a moment for force kill to take effect
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Verify it's really gone
    if (isProcessRunning(pid)) {
      throw new Error('Process survived SIGKILL');
    }
  }
  
  return terminated;
}