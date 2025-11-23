import * as fs from 'fs/promises';
import { PosixStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning, printError } from '../../../core/io/cli-logger.js';
import { getGraphPaths } from './graph-paths.js';

/**
 * Stop handler for graph database services on POSIX systems
 * Currently supports JanusGraph
 */
const stopGraphService = async (context: PosixStopHandlerContext): Promise<StopHandlerResult> => {
  const { service } = context;
  
  // Determine which graph database to stop from service config
  const graphType = service.config.type;
  
  if (!service.quiet) {
    printInfo(`🛑 Stopping ${graphType} graph database...`);
  }
  
  if (graphType === 'janusgraph') {
    return stopJanusGraph(context);
  }
  
  return {
    success: false,
    error: `Unsupported graph database: ${graphType}`,
    metadata: { serviceType: 'graph', serviceName: graphType }
  };
};

async function stopJanusGraph(context: PosixStopHandlerContext): Promise<StopHandlerResult> {
  const { service, options } = context;

  // Get graph paths
  const paths = getGraphPaths(context);
  const { pidFile } = paths;
  
  // Check if PID file exists
  if (!await fileExists(pidFile)) {
    if (!service.quiet) {
      printWarning('JanusGraph is not running (no PID file found)');
    }
    return {
      success: true,
      metadata: { 
        serviceType: 'graph', 
        serviceName: 'janusgraph',
        alreadyStopped: true 
      }
    };
  }
  
  try {
    const pidStr = await fs.readFile(pidFile, 'utf-8');
    const pid = parseInt(pidStr);
    
    // Check if process is actually running
    try {
      process.kill(pid, 0); // Check if process exists
    } catch {
      // Process doesn't exist, clean up pid file
      await fs.unlink(pidFile);
      if (!service.quiet) {
        printWarning('JanusGraph process not found, cleaned up PID file');
      }
      return {
        success: true,
        metadata: { 
          serviceType: 'graph', 
          serviceName: 'janusgraph',
          alreadyStopped: true 
        }
      };
    }
    
    const stopTime = new Date();
    
    if (options.force) {
      // Force kill the process
      if (!service.quiet) {
        printInfo('Force stopping JanusGraph...');
      }
      
      process.kill(pid, 'SIGKILL');
      
      // Clean up PID file
      await fs.unlink(pidFile);
      
      if (!service.quiet) {
        printSuccess(`✅ JanusGraph force stopped (PID: ${pid})`);
      }
      
      return {
        success: true,
        stopTime,
        graceful: false,
        metadata: {
          serviceType: 'graph',
          serviceName: 'janusgraph',
          pid
        }
      };
    } else {
      // Graceful shutdown with SIGTERM
      if (!service.quiet) {
        printInfo(`Stopping JanusGraph gracefully (PID: ${pid})...`);
      }
      
      process.kill(pid, 'SIGTERM');
      
      // Wait for process to terminate (with timeout)
      const timeout = (options.timeout || 30) * 1000;
      const startTime = Date.now();
      let processRunning = true;
      
      while (processRunning && (Date.now() - startTime) < timeout) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        try {
          process.kill(pid, 0); // Check if still running
        } catch {
          processRunning = false;
        }
      }
      
      if (processRunning) {
        // Timeout reached, force kill
        if (!service.quiet) {
          printWarning('Graceful shutdown timeout reached, force stopping...');
        }
        process.kill(pid, 'SIGKILL');
        
        // Clean up PID file
        await fs.unlink(pidFile);
        
        return {
          success: true,
          stopTime,
          graceful: false,
          metadata: {
            serviceType: 'graph',
            serviceName: 'janusgraph',
            pid,
            timeoutReached: true
          }
        };
      } else {
        // Clean up PID file
        await fs.unlink(pidFile);
        
        if (!service.quiet) {
          printSuccess(`✅ JanusGraph stopped gracefully (PID: ${pid})`);
        }
        
        return {
          success: true,
          stopTime,
          graceful: true,
          metadata: {
            serviceType: 'graph',
            serviceName: 'janusgraph',
            pid
          }
        };
      }
    }
    
  } catch (error) {
    if (!service.quiet) {
      printError(`Failed to stop JanusGraph: ${error}`);
    }
    return {
      success: false,
      error: `Failed to stop JanusGraph: ${error}`,
      metadata: { serviceType: 'graph', serviceName: 'janusgraph' }
    };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Handler descriptor for graph database stop
 */
export const graphStopDescriptor: HandlerDescriptor<PosixStopHandlerContext, StopHandlerResult> = {
  command: 'stop',
  platform: 'posix',
  serviceType: 'graph',
  handler: stopGraphService
};