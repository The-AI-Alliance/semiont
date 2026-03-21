import * as path from 'path';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import { SemiontProject } from '@semiont/core/node';

export interface InferencePaths {
  pidFile: string;
  logsDir: string;
  appLogFile: string;
  errorLogFile: string;
}

export function getInferencePaths<T>(context: BaseHandlerContext<T>): InferencePaths {
  const projectRoot = context.service.projectRoot;
  const project = new SemiontProject(projectRoot);
  const logsDir = path.join(project.stateDir, 'inference');

  return {
    pidFile: path.join(project.runtimeDir, 'ollama.pid'),
    logsDir,
    appLogFile: path.join(logsDir, 'ollama.log'),
    errorLogFile: path.join(logsDir, 'ollama-error.log'),
  };
}
