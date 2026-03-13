import * as fs from 'fs';
import { PosixStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';
import { getInferencePaths } from './inference-paths.js';
import { passingPreflight } from '../../../core/handlers/preflight-utils.js';

const stopInference = async (context: PosixStopHandlerContext): Promise<StopHandlerResult> => {
  const { service, options } = context;
  const paths = getInferencePaths(context);

  if (!fs.existsSync(paths.pidFile)) {
    if (!service.quiet) {
      printWarning('Ollama is not running (no PID file found — may be running as a system service)');
    }
    return {
      success: true,
      metadata: { serviceType: 'inference', alreadyStopped: true }
    };
  }

  const pidStr = fs.readFileSync(paths.pidFile, 'utf-8');
  const pid = parseInt(pidStr);

  // Check if process is actually running
  try {
    process.kill(pid, 0);
  } catch {
    fs.unlinkSync(paths.pidFile);
    if (!service.quiet) {
      printWarning('Ollama process not found, cleaned up PID file');
    }
    return {
      success: true,
      metadata: { serviceType: 'inference', alreadyStopped: true }
    };
  }

  const stopTime = new Date();

  if (options.force) {
    if (!service.quiet) {
      printInfo('Force stopping Ollama...');
    }
    process.kill(pid, 'SIGKILL');
    fs.unlinkSync(paths.pidFile);

    if (!service.quiet) {
      printSuccess(`Ollama force stopped (PID: ${pid})`);
    }

    return {
      success: true,
      stopTime,
      graceful: false,
      metadata: { serviceType: 'inference', pid }
    };
  }

  // Graceful shutdown
  if (!service.quiet) {
    printInfo(`Stopping Ollama gracefully (PID: ${pid})...`);
  }

  process.kill(pid, 'SIGTERM');

  const timeout = options.timeout * 1000;
  const startTime = Date.now();
  let processRunning = true;

  while (processRunning && (Date.now() - startTime) < timeout) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      process.kill(pid, 0);
    } catch {
      processRunning = false;
    }
  }

  if (processRunning) {
    if (!service.quiet) {
      printWarning('Graceful shutdown timeout reached, force stopping...');
    }
    process.kill(pid, 'SIGKILL');
  }

  fs.unlinkSync(paths.pidFile);

  if (!service.quiet) {
    printSuccess(`Ollama stopped ${processRunning ? '(forced)' : 'gracefully'} (PID: ${pid})`);
  }

  return {
    success: true,
    stopTime,
    graceful: !processRunning,
    metadata: {
      serviceType: 'inference',
      pid,
      timeoutReached: processRunning,
    }
  };
};

export const inferenceStopDescriptor: HandlerDescriptor<PosixStopHandlerContext, StopHandlerResult> = {
  command: 'stop',
  platform: 'posix',
  serviceType: 'inference',
  handler: stopInference,
  preflight: async () => passingPreflight(),
};
