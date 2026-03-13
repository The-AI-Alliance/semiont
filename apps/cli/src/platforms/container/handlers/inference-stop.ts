import { execFileSync } from 'child_process';
import { ContainerStopHandlerContext, StopHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';
import { checkContainerRuntime, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

const stopInference = async (context: ContainerStopHandlerContext): Promise<StopHandlerResult> => {
  const { service, runtime, options, containerName } = context;

  // Check if container is running
  try {
    const output = execFileSync(runtime, ['ps', '--format', '{{.Names}}'], { encoding: 'utf-8' });
    if (!output.includes(containerName)) {
      if (!service.quiet) {
        printWarning('Ollama container is not running');
      }
      return {
        success: true,
        metadata: { serviceType: 'inference', alreadyStopped: true }
      };
    }
  } catch {
    return {
      success: false,
      error: 'Container runtime not available',
      metadata: { serviceType: 'inference' }
    };
  }

  const stopTime = new Date();

  try {
    if (options.force) {
      if (!service.quiet) {
        printInfo('Force stopping Ollama container...');
      }
      execFileSync(runtime, ['rm', '-f', containerName], {
        stdio: service.quiet ? 'ignore' : 'inherit',
      });
    } else {
      if (!service.quiet) {
        printInfo(`Stopping Ollama container gracefully (timeout: ${options.timeout}s)...`);
      }
      execFileSync(runtime, ['stop', '-t', options.timeout.toString(), containerName], {
        stdio: service.quiet ? 'ignore' : 'inherit',
      });
      execFileSync(runtime, ['rm', containerName], {
        stdio: 'ignore',
      });
    }

    if (!service.quiet) {
      printSuccess(`Ollama container stopped${options.force ? ' (forced)' : ' gracefully'}`);
    }

    return {
      success: true,
      stopTime,
      graceful: !options.force,
      metadata: {
        serviceType: 'inference',
        containerName,
      }
    };

  } catch (error) {
    return {
      success: false,
      error: `Failed to stop Ollama container: ${error}`,
      metadata: { serviceType: 'inference' }
    };
  }
};

const preflightInferenceStop = async (context: ContainerStopHandlerContext): Promise<PreflightResult> => {
  return preflightFromChecks([
    checkContainerRuntime(context.runtime),
  ]);
};

export const inferenceStopDescriptor: HandlerDescriptor<ContainerStopHandlerContext, StopHandlerResult> = {
  command: 'stop',
  platform: 'container',
  serviceType: 'inference',
  handler: stopInference,
  preflight: preflightInferenceStop,
};
