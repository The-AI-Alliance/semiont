import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PosixStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';

/**
 * Stop handler for filesystem services on POSIX systems
 * 
 * Handles cleanup and unmounting of filesystem services.
 * This includes closing file handles, syncing data, and optionally
 * cleaning temporary files.
 */
const stopFilesystemService = async (context: PosixStopHandlerContext): Promise<StopHandlerResult> => {
  const { service, options } = context;
  const cleanTemp = options.clean || false;
  
  if (!service.quiet) {
    printInfo(`Stopping filesystem service ${service.name}...`);
  }
  
  const metadata: Record<string, any> = {
    serviceType: 'filesystem',
    cleaned: []
  };
  
  // Get the configured path
  const basePath = service.config.path || path.join(process.cwd(), 'data', service.name);
  const absolutePath = path.isAbsolute(basePath) ? basePath : path.join(service.projectRoot, basePath);
  
  // Check if the filesystem path exists
  if (!fs.existsSync(absolutePath)) {
    if (!service.quiet) {
      printWarning(`Filesystem path does not exist: ${absolutePath}`);
    }
    return {
      success: true,
      stopTime: new Date(),
      graceful: true,
      metadata: {
        ...metadata,
        pathExists: false,
        path: absolutePath
      }
    };
  }
  
  try {
    // Sync filesystem to ensure all data is written
    if (!service.quiet) {
      printInfo('Syncing filesystem data...');
    }
    
    try {
      execSync('sync', { stdio: 'ignore' });
    } catch {
      // sync might not be available on all systems
    }
    
    // Check for any processes using the filesystem
    let processesUsingFs: string[] = [];
    try {
      // Use lsof to find processes using the filesystem path
      const lsofOutput = execSync(`lsof +D "${absolutePath}" 2>/dev/null || true`, { 
        encoding: 'utf-8',
        stdio: 'pipe' 
      });
      
      if (lsofOutput) {
        const lines = lsofOutput.split('\n').filter(line => line.trim());
        if (lines.length > 1) { // First line is header
          processesUsingFs = lines.slice(1).map(line => {
            const parts = line.split(/\s+/);
            return parts[0]; // Process name
          }).filter((v, i, a) => a.indexOf(v) === i); // Unique values
          
          if (!service.quiet && processesUsingFs.length > 0) {
            printWarning(`Processes still using filesystem: ${processesUsingFs.join(', ')}`);
          }
        }
      }
    } catch {
      // lsof might not be available or fail
    }
    
    metadata.processesUsingFs = processesUsingFs;
    
    // Clean temporary files if requested
    if (cleanTemp) {
      const tempPath = path.join(absolutePath, 'temp');
      const cachePath = path.join(absolutePath, 'cache');
      
      if (fs.existsSync(tempPath)) {
        if (!service.quiet) {
          printInfo('Cleaning temporary files...');
        }
        
        // Remove contents of temp directory but keep the directory
        const tempFiles = fs.readdirSync(tempPath);
        for (const file of tempFiles) {
          const filePath = path.join(tempPath, file);
          try {
            if (fs.statSync(filePath).isDirectory()) {
              fs.rmSync(filePath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(filePath);
            }
            metadata.cleaned.push(filePath);
          } catch (error) {
            printWarning(`Could not remove ${filePath}: ${error}`);
          }
        }
      }
      
      // Optionally clean cache
      if (options.clearCache && fs.existsSync(cachePath)) {
        if (!service.quiet) {
          printInfo('Clearing cache...');
        }
        
        const cacheFiles = fs.readdirSync(cachePath);
        for (const file of cacheFiles) {
          const filePath = path.join(cachePath, file);
          try {
            if (fs.statSync(filePath).isDirectory()) {
              fs.rmSync(filePath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(filePath);
            }
            metadata.cleaned.push(filePath);
          } catch (error) {
            printWarning(`Could not remove ${filePath}: ${error}`);
          }
        }
      }
    }
    
    // Get final disk usage statistics
    try {
      const dfOutput = execSync(`df -h "${absolutePath}"`, { encoding: 'utf-8' });
      const lines = dfOutput.split('\n');
      if (lines.length > 1) {
        const stats = lines[1].split(/\s+/);
        if (stats.length >= 4) {
          metadata.finalDiskUsage = {
            available: stats[3],
            total: stats[1],
            used: stats[2],
            usagePercent: stats[4]
          };
        }
      }
    } catch {
      // df command might not be available
    }
    
    metadata.path = absolutePath;
    
    if (!service.quiet) {
      printSuccess(`✅ Filesystem service ${service.name} stopped successfully`);
      if (metadata.cleaned.length > 0) {
        printInfo(`Cleaned ${metadata.cleaned.length} temporary files`);
      }
      if (processesUsingFs.length > 0) {
        printWarning('Note: Some processes may still be using the filesystem');
      }
    }
    
    return {
      success: true,
      stopTime: new Date(),
      graceful: true,
      metadata
    };
    
  } catch (error) {
    return {
      success: false,
      error: `Failed to stop filesystem service: ${error}`,
      metadata
    };
  }
};

/**
 * Descriptor for filesystem POSIX stop handler
 */
export const filesystemStopDescriptor: HandlerDescriptor<PosixStopHandlerContext, StopHandlerResult> = {
  command: 'stop',
  platform: 'posix',
  serviceType: 'filesystem',
  handler: stopFilesystemService
};