import * as fs from 'fs';
import { execSync } from 'child_process';
import { PosixCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { getFilesystemPaths } from './filesystem-paths.js';

/**
 * Check handler for POSIX filesystem services
 * 
 * For filesystem services, we check if the directory exists and is accessible,
 * not whether a process is running (since it's passive storage).
 */
const checkFilesystemService = async (context: PosixCheckHandlerContext): Promise<CheckHandlerResult> => {
  // Get filesystem paths
  const paths = getFilesystemPaths(context);
  const { baseDir: absolutePath, uploadsDir, tempDir, cacheDir, logsDir } = paths;

  let status: 'running' | 'stopped' | 'unknown' | 'unhealthy' = 'unknown';
  let healthy = false;
  let details: Record<string, unknown> = {
    path: absolutePath
  };
  
  // Check if the filesystem directory exists
  if (!fs.existsSync(absolutePath)) {
    status = 'stopped';
    details.message = 'Filesystem directory does not exist';
  } else {
    // Check if it's accessible for reading and writing
    try {
      fs.accessSync(absolutePath, fs.constants.R_OK | fs.constants.W_OK);
      status = 'running';  // For filesystem, "running" means accessible
      healthy = true;
      details.message = 'Filesystem is accessible and ready';
      details.accessible = 'read/write';
      
      // Get directory stats
      const stats = fs.statSync(absolutePath);
      details.created = stats.birthtime;
      details.modified = stats.mtime;
      
      // Count files and subdirectories
      try {
        const entries = fs.readdirSync(absolutePath);
        details.entries = entries.length;
        
        // Check standard subdirectories
        const standardDirs = [
          { dir: uploadsDir, name: 'uploads' },
          { dir: tempDir, name: 'temp' },
          { dir: cacheDir, name: 'cache' },
          { dir: logsDir, name: 'logs' }
        ];
        const existingDirs = standardDirs
          .filter(item => fs.existsSync(item.dir))
          .map(item => item.name);
        details.subdirectories = existingDirs;
      } catch {
        // Can't read directory contents
      }
      
      // Check disk usage
      try {
        const dfOutput = execSync(`df -h "${absolutePath}"`, { encoding: 'utf-8' });
        const lines = dfOutput.split('\n');
        if (lines.length > 1) {
          const stats = lines[1].split(/\s+/);
          if (stats.length >= 4) {
            details.diskSpace = {
              available: stats[3],
              total: stats[1],
              used: stats[2],
              usagePercent: stats[4]
            };
            
            // Warn if disk usage is high
            const usagePercent = parseInt(stats[4]);
            if (usagePercent > 90) {
              healthy = false;
              details.warning = `High disk usage: ${stats[4]}`;
            } else if (usagePercent > 80) {
              details.warning = `Disk usage at ${stats[4]}`;
            }
          }
        }
      } catch {
        // df command might not be available
      }
      
    } catch (error) {
      status = 'unhealthy';
      details.message = `Filesystem exists but is not accessible: ${error}`;
      
      // Check if it's readable at least
      try {
        fs.accessSync(absolutePath, fs.constants.R_OK);
        details.accessible = 'read-only';
      } catch {
        details.accessible = 'none';
      }
    }
  }
  
  // Build platform resources
  const platformResources = status === 'running' ? {
    platform: 'posix' as const,
    data: {
      path: absolutePath,
      workingDirectory: absolutePath
    }
  } : undefined;
  
  return {
    success: true,
    status,
    platformResources,
    health: {
      healthy,
      details
    },
    metadata: {
      serviceType: 'filesystem',
      path: absolutePath
    }
  };
};

/**
 * Descriptor for POSIX filesystem check handler
 */
export const filesystemCheckDescriptor: HandlerDescriptor<PosixCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'filesystem',
  handler: checkFilesystemService
};