import * as path from 'path';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';

export interface InferencePaths {
  runtimeDir: string;
  pidFile: string;
  logsDir: string;
  appLogFile: string;
  errorLogFile: string;
}

export function getInferencePaths<T>(context: BaseHandlerContext<T>): InferencePaths {
  const projectRoot = context.service.projectRoot;
  const runtimeDir = path.join(projectRoot, 'inference');

  return {
    runtimeDir,
    pidFile: path.join(runtimeDir, 'ollama.pid'),
    logsDir: path.join(runtimeDir, 'logs'),
    appLogFile: path.join(runtimeDir, 'logs', 'ollama.log'),
    errorLogFile: path.join(runtimeDir, 'logs', 'ollama-error.log'),
  };
}
