import * as path from 'path';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';

/**
 * Filesystem service paths on POSIX platform.
 * Base directory is always <projectRoot>/.semiont/data
 */
export interface FilesystemPaths {
  baseDir: string;        // Main filesystem storage directory
  uploadsDir: string;     // Uploads subdirectory
  tempDir: string;        // Temporary files subdirectory
  cacheDir: string;       // Cache subdirectory
  logsDir: string;        // Logs subdirectory
}

/**
 * Get all filesystem paths for POSIX platform.
 * The base directory is fixed at <projectRoot>/.semiont/data.
 */
export function getFilesystemPaths<T>(context: BaseHandlerContext<T>): FilesystemPaths {
  const baseDir = path.join(context.service.projectRoot, '.semiont', 'data');

  return {
    baseDir,
    uploadsDir: path.join(baseDir, 'uploads'),
    tempDir: path.join(baseDir, 'temp'),
    cacheDir: path.join(baseDir, 'cache'),
    logsDir: path.join(baseDir, 'logs')
  };
}
