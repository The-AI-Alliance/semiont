import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { PosixStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { PlatformResources } from '../../platform-resources.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';

/**
 * Start handler for filesystem services on POSIX systems
 * 
 * For filesystem services, "start" means ensuring the filesystem is ready
 * and accessible. There's no process to spawn since it's passive storage.
 */
const startFilesystemService = async (context: PosixStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  
  // Get the configured path
  const basePath = service.config.path || path.join(process.cwd(), 'data', service.name);
  const absolutePath = path.isAbsolute(basePath) ? basePath : path.join(service.projectRoot, basePath);
  
  if (!service.quiet) {
    printInfo(`Starting filesystem service ${service.name}...`);
  }
  
  // Ensure the filesystem directory exists
  if (!fs.existsSync(absolutePath)) {
    // Create it if it doesn't exist
    try {
      fs.mkdirSync(absolutePath, { recursive: true });
      if (!service.quiet) {
        printInfo(`Created filesystem directory: ${absolutePath}`);
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to create filesystem directory: ${error}`,
        metadata: {
          serviceType: 'filesystem',
          path: absolutePath
        }
      };
    }
  }
  
  // Verify the directory is accessible
  try {
    fs.accessSync(absolutePath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    return {
      success: false,
      error: `Filesystem directory is not accessible: ${error}`,
      metadata: {
        serviceType: 'filesystem',
        path: absolutePath
      }
    };
  }
  
  // Ensure standard subdirectories exist
  const standardDirs = ['uploads', 'temp', 'cache', 'logs'];
  for (const dir of standardDirs) {
    const dirPath = path.join(absolutePath, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      if (!service.quiet) {
        printInfo(`Created subdirectory: ${dir}/`);
      }
    }
  }
  
  // Check disk space
  let diskInfo: any = {};
  try {
    const dfOutput = execSync(`df -h "${absolutePath}"`, { encoding: 'utf-8' });
    const lines = dfOutput.split('\n');
    if (lines.length > 1) {
      const stats = lines[1].split(/\s+/);
      if (stats.length >= 4) {
        diskInfo = {
          available: stats[3],
          total: stats[1],
          used: stats[2],
          usagePercent: stats[4]
        };
        
        if (!service.quiet) {
          printInfo(`Disk space: ${stats[3]} available (${stats[4]} used)`);
        }
        
        // Warn if disk space is low
        const usagePercent = parseInt(stats[4]);
        if (usagePercent > 90) {
          printWarning(`Low disk space warning: ${stats[4]} used`);
        }
      }
    }
  } catch {
    // df command might not be available
  }
  
  // Build resources information
  const resources: PlatformResources = {
    platform: 'posix',
    data: {
      path: absolutePath,
      workingDirectory: absolutePath
    }
  };
  
  if (!service.quiet) {
    printSuccess(`✅ Filesystem service ${service.name} is ready`);
    printInfo('');
    printInfo('Filesystem details:');
    printInfo(`  Path: ${absolutePath}`);
    printInfo(`  Accessible: Read/Write`);
    if (diskInfo.available) {
      printInfo(`  Available space: ${diskInfo.available}`);
      printInfo(`  Usage: ${diskInfo.usagePercent}`);
    }
    printInfo('');
    printInfo('The filesystem is ready for use by other services.');
  }
  
  return {
    success: true,
    resources,
    metadata: {
      serviceType: 'filesystem',
      path: absolutePath,
      accessible: true,
      diskInfo,
      directories: standardDirs.map(dir => path.join(absolutePath, dir))
    }
  };
};

/**
 * Descriptor for filesystem POSIX start handler
 */
export const filesystemStartDescriptor: HandlerDescriptor<PosixStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'posix',
  serviceType: 'filesystem',
  handler: startFilesystemService
};