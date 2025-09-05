/**
 * POSIX platform resources - for services running as OS processes
 */
export interface PosixResources {
  pid?: number;
  port?: number;
  path?: string;              // File system path (for filesystem services)
  workingDirectory?: string;
  command?: string;
  logFile?: string;
}
