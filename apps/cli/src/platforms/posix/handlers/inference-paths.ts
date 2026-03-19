import * as path from 'path';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import { getRuntimeDir, getStateDir } from '../../../core/handlers/preflight-utils.js';
import { readProjectName } from '../../../core/config-loader.js';

export interface InferencePaths {
  runtimeDir: string;
  pidFile: string;
  logsDir: string;
  appLogFile: string;
  errorLogFile: string;
}

export function getInferencePaths<T>(context: BaseHandlerContext<T>): InferencePaths {
  const projectRoot = context.service.projectRoot;
  const projectName = readProjectName(projectRoot);
  const runtimeDir = path.join(projectRoot, 'inference');
  const logsDir = path.join(getStateDir(projectName), 'inference');

  return {
    runtimeDir,
    pidFile: path.join(getRuntimeDir(projectName), 'ollama.pid'),
    logsDir,
    appLogFile: path.join(logsDir, 'ollama.log'),
    errorLogFile: path.join(logsDir, 'ollama-error.log'),
  };
}
