import * as fs from 'fs';
import { spawn } from 'child_process';
import { PosixStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';
import { getInferencePaths } from './inference-paths.js';
import type { OllamaProviderConfig } from '@semiont/core';
import { checkCommandAvailable, checkPortFree, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

const OLLAMA_DEFAULT_PORT = 11434;

const startInference = async (context: PosixStartHandlerContext): Promise<StartHandlerResult> => {
  const { service } = context;
  const serviceConfig = service.config as unknown as OllamaProviderConfig;
  const port = serviceConfig.port || OLLAMA_DEFAULT_PORT;

  const paths = getInferencePaths(context);

  // Check if Ollama is already running (system service or prior start)
  const alreadyRunning = await isOllamaRunning(port);
  if (alreadyRunning) {
    if (!service.quiet) {
      printWarning(`Ollama is already running on port ${port}`);
    }
    return {
      success: true,
      endpoint: `http://localhost:${port}`,
      metadata: {
        serviceType: 'inference',
        port,
        alreadyRunning: true,
      }
    };
  }

  // Create runtime directories
  fs.mkdirSync(paths.logsDir, { recursive: true });

  if (!service.quiet) {
    printInfo(`Starting Ollama on port ${port}...`);
  }

  // Open log files
  const appLogFd = fs.openSync(paths.appLogFile, 'a');
  const errorLogFd = fs.openSync(paths.errorLogFile, 'a');

  const child = spawn('ollama', ['serve'], {
    detached: true,
    stdio: ['ignore', appLogFd, errorLogFd],
    env: {
      ...process.env,
      OLLAMA_HOST: `0.0.0.0:${port}`,
    },
  });

  fs.closeSync(appLogFd);
  fs.closeSync(errorLogFd);

  if (!child.pid) {
    return {
      success: false,
      error: 'Failed to start Ollama process',
      metadata: { serviceType: 'inference' }
    };
  }

  child.unref();

  // Save PID
  fs.writeFileSync(paths.pidFile, child.pid.toString());

  // Wait for server to be ready
  const maxAttempts = 15;
  let ready = false;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (await isOllamaRunning(port)) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    // Clean up
    try {
      process.kill(child.pid);
      fs.unlinkSync(paths.pidFile);
    } catch {}

    return {
      success: false,
      error: 'Ollama failed to start within timeout',
      metadata: { serviceType: 'inference', port }
    };
  }

  if (!service.quiet) {
    printSuccess(`Ollama started on port ${port} (PID: ${child.pid})`);
  }

  return {
    success: true,
    endpoint: `http://localhost:${port}`,
    resources: {
      platform: 'posix',
      data: {
        pid: child.pid,
        port,
      }
    },
    metadata: {
      serviceType: 'inference',
      pid: child.pid,
      port,
    }
  };
};

async function isOllamaRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

const preflightInferenceStart = async (context: PosixStartHandlerContext): Promise<PreflightResult> => {
  const serviceConfig = context.service.config as unknown as OllamaProviderConfig;
  const port = serviceConfig.port || OLLAMA_DEFAULT_PORT;

  return preflightFromChecks([
    checkCommandAvailable('ollama'),
    await checkPortFree(port),
  ]);
};

export const inferenceStartDescriptor: HandlerDescriptor<PosixStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'posix',
  serviceType: 'inference',
  handler: startInference,
  preflight: preflightInferenceStart,
};
