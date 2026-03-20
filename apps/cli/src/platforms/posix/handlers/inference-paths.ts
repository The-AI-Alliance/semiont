import * as path from 'path';
import type { BaseHandlerContext } from '../../../core/handlers/types.js';
import { SemiontProject } from '@semiont/core';

export interface InferencePaths {
  runtimeDir: string;
  pidFile: string;
  logsDir: string;
  appLogFile: string;
  errorLogFile: string;
}

export function getInferencePaths<T>(context: BaseHandlerContext<T>): InferencePaths {
  const projectRoot = context.service.projectRoot;
  const project = new SemiontProject(projectRoot);
  const runtimeDir = path.join(projectRoot, 'inference');
  const logsDir = path.join(project.stateDir, 'inference');

  return {
    runtimeDir,
    pidFile: path.join(project.runtimeDir, 'ollama.pid'),
    logsDir,
    appLogFile: path.join(logsDir, 'ollama.log'),
    errorLogFile: path.join(logsDir, 'ollama-error.log'),
  };
}
