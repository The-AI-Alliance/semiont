import * as path from 'path';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import type { FilesystemServiceConfig } from '@semiont/core';

/**
 * Filesystem service paths on POSIX platform
 * Paths are configurable via service config
 */
export interface FilesystemPaths {
  baseDir: string;        // Main filesystem storage directory
  uploadsDir: string;     // Uploads subdirectory
  tempDir: string;        // Temporary files subdirectory
  cacheDir: string;       // Cache subdirectory
  logsDir: string;        // Logs subdirectory
}

/**
 * Get all filesystem paths for POSIX platform
 */
export function getFilesystemPaths<T>(context: BaseHandlerContext<T>): FilesystemPaths {
  const service = context.service;

  // Type narrowing for filesystem service config
  const config = service.config as FilesystemServiceConfig;
  const basePath = config.path;
  if (!basePath) {
    throw new Error('Filesystem path not configured');
  }

  const baseDir = path.isAbsolute(basePath) ?
    basePath :
    path.join(service.projectRoot, basePath);

  return {
    baseDir,
    uploadsDir: path.join(baseDir, 'uploads'),
    tempDir: path.join(baseDir, 'temp'),
    cacheDir: path.join(baseDir, 'cache'),
    logsDir: path.join(baseDir, 'logs')
  };
}