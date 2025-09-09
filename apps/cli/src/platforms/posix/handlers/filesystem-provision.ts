import * as fs from 'fs';
import * as path from 'path';
import { PosixProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';

/**
 * Provision handler for filesystem services on POSIX systems
 * 
 * Sets up the necessary directory structure and permissions for filesystem storage.
 * This includes creating data directories, setting up access permissions,
 * and optionally initializing with default content.
 */
const provisionFilesystemService = async (context: PosixProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service } = context;
  const requirements = service.getRequirements();
  
  if (!service.quiet) {
    printInfo(`Provisioning filesystem service ${service.name}...`);
  }
  
  const metadata: Record<string, any> = {
    serviceType: 'filesystem',
    directories: []
  };
  
  // Get the configured path from service config, or use default
  const basePath = service.config.path || path.join(process.cwd(), 'data', service.name);
  const absolutePath = path.isAbsolute(basePath) ? basePath : path.join(service.projectRoot, basePath);
  
  // Create the main filesystem directory
  try {
    fs.mkdirSync(absolutePath, { recursive: true });
    metadata.directories.push(absolutePath);
    
    if (!service.quiet) {
      printInfo(`Created directory: ${absolutePath}`);
    }
    
    // Check and set permissions (make it writable)
    try {
      fs.chmodSync(absolutePath, 0o755);
    } catch (error) {
      printWarning(`Could not set permissions on ${absolutePath}: ${error}`);
    }
    
    // Create subdirectories based on requirements
    if (requirements.storage) {
      for (const storage of requirements.storage) {
        const subPath = storage.mountPath || path.join(absolutePath, storage.volumeName || 'default');
        const absSubPath = path.isAbsolute(subPath) ? subPath : path.join(service.projectRoot, subPath);
        
        fs.mkdirSync(absSubPath, { recursive: true });
        metadata.directories.push(absSubPath);
        
        if (!service.quiet) {
          printInfo(`Created storage directory: ${absSubPath}`);
        }
        
        // Set permissions
        try {
          fs.chmodSync(absSubPath, 0o755);
        } catch (error) {
          printWarning(`Could not set permissions on ${absSubPath}: ${error}`);
        }
      }
    }
    
    // Create standard subdirectories for common use cases
    const standardDirs = ['uploads', 'temp', 'cache', 'logs'];
    for (const dir of standardDirs) {
      const dirPath = path.join(absolutePath, dir);
      fs.mkdirSync(dirPath, { recursive: true });
      metadata.directories.push(dirPath);
    }
    
    // Check available disk space
    try {
      const { execSync } = require('child_process');
      const dfOutput = execSync(`df -h "${absolutePath}"`, { encoding: 'utf-8' });
      const lines = dfOutput.split('\n');
      if (lines.length > 1) {
        const stats = lines[1].split(/\s+/);
        if (stats.length >= 4) {
          metadata.availableSpace = stats[3];
          metadata.totalSpace = stats[1];
          metadata.usedSpace = stats[2];
          metadata.usagePercent = stats[4];
          
          if (!service.quiet) {
            printInfo(`Disk space: ${stats[3]} available (${stats[4]} used)`);
          }
        }
      }
    } catch {
      // df command might not be available or fail
    }
    
    // Create a README file to document the filesystem structure
    const readmePath = path.join(absolutePath, 'README.md');
    if (!fs.existsSync(readmePath)) {
      const readmeContent = `# Semiont Filesystem Storage

This directory contains filesystem storage for the Semiont ${service.name} service.

## Directory Structure

- \`uploads/\` - User uploaded files
- \`temp/\` - Temporary files (can be cleaned periodically)
- \`cache/\` - Cached data
- \`logs/\` - Service logs

## Configuration

Environment: ${service.environment}
Path: ${absolutePath}
Created: ${new Date().toISOString()}

## Usage

This filesystem is mounted by services that require persistent file storage.
Files placed here will persist across service restarts.

## Maintenance

- The \`temp/\` directory can be cleaned periodically
- Monitor disk usage to ensure adequate space
- Regular backups are recommended for important data
`;
      fs.writeFileSync(readmePath, readmeContent);
      
      if (!service.quiet) {
        printInfo('Created README.md documentation');
      }
    }
    
    metadata.path = absolutePath;
    metadata.configured = true;
    
    if (!service.quiet) {
      printSuccess(`✅ Filesystem service ${service.name} provisioned successfully`);
      printInfo('');
      printInfo('Filesystem details:');
      printInfo(`  Path: ${absolutePath}`);
      printInfo(`  Directories: ${metadata.directories.length} created`);
      if (metadata.availableSpace) {
        printInfo(`  Available space: ${metadata.availableSpace}`);
      }
      printInfo('');
      printInfo('To start the filesystem service:');
      printInfo(`  semiont start --service ${service.name} --environment ${service.environment}`);
    }
    
    return {
      success: true,
      metadata,
      resources: {
        platform: 'posix',
        data: {
          path: absolutePath,
          workingDirectory: absolutePath
        }
      }
    };
    
  } catch (error) {
    return {
      success: false,
      error: `Failed to provision filesystem: ${error}`,
      metadata
    };
  }
};

/**
 * Descriptor for filesystem POSIX provision handler
 */
export const filesystemProvisionDescriptor: HandlerDescriptor<PosixProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'posix',
  serviceType: 'filesystem',
  handler: provisionFilesystemService
};