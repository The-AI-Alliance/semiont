import { execFileSync } from 'child_process';
import { ContainerStartHandlerContext, StartHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess, printWarning } from '../../../core/io/cli-logger.js';
import type { InferenceServiceConfig } from '@semiont/core';
import { checkContainerRuntime, checkPortFree, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

const OLLAMA_IMAGE = 'ollama/ollama';
const OLLAMA_DEFAULT_PORT = 11434;
const VOLUME_NAME = 'semiont-ollama-models';

const startInference = async (context: ContainerStartHandlerContext): Promise<StartHandlerResult> => {
  const { service, runtime, containerName } = context;
  const serviceConfig = service.config as InferenceServiceConfig;
  const port = serviceConfig.port || OLLAMA_DEFAULT_PORT;
  const image = serviceConfig.image || OLLAMA_IMAGE;

  // Check if container is already running
  try {
    const output = execFileSync(runtime, ['ps', '--format', '{{.Names}}'], { encoding: 'utf-8' });
    if (output.includes(containerName)) {
      if (!service.quiet) {
        printWarning('Ollama container is already running');
      }
      return {
        success: true,
        endpoint: `http://localhost:${port}`,
        metadata: {
          serviceType: 'inference',
          containerId: containerName,
          alreadyRunning: true,
        }
      };
    }
  } catch {
    // Docker might not be available
  }

  // Remove any stopped container with the same name
  try {
    execFileSync(runtime, ['rm', '-f', containerName], { stdio: 'ignore' });
  } catch {
    // Container might not exist
  }

  if (!service.quiet) {
    printInfo(`Starting Ollama container on port ${port}...`);
  }

  // Detect GPU for --gpus flag
  const gpuArgs = detectNvidiaGpu() ? ['--gpus', 'all'] : [];

  try {
    const containerId = execFileSync(runtime, [
      'run', '-d',
      '--name', containerName,
      ...gpuArgs,
      '-p', `${port}:11434`,
      '-v', `${VOLUME_NAME}:/root/.ollama`,
      image,
    ], {
      encoding: 'utf-8',
    }).trim();

    // Wait for Ollama to be ready
    let ready = false;
    const maxAttempts = 15;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        const status = execFileSync(
          runtime, ['inspect', containerName, '--format', '{{.State.Status}}'],
          { encoding: 'utf-8', stdio: 'pipe' }
        ).trim();

        if (status === 'running') {
          // Check if API is responding
          try {
            const res = await fetch(`http://localhost:${port}/api/tags`);
            if (res.ok) {
              ready = true;
              break;
            }
          } catch {
            // Not ready yet
          }
        }
      } catch {
        // Container not ready
      }
    }

    if (!ready) {
      try {
        execFileSync(runtime, ['rm', '-f', containerName], { stdio: 'ignore' });
      } catch {}

      return {
        success: false,
        error: 'Ollama container failed to start within timeout',
        metadata: { serviceType: 'inference', port }
      };
    }

    if (!service.quiet) {
      printSuccess(`Ollama container started on port ${port}`);
      if (gpuArgs.length > 0) {
        printInfo('GPU passthrough enabled');
      }
    }

    return {
      success: true,
      endpoint: `http://localhost:${port}`,
      resources: {
        platform: 'container',
        data: {
          id: containerName,
          containerId,
          imageName: image,
          ports: { '11434': String(port) },
          volumes: [{ host: VOLUME_NAME, container: '/root/.ollama', mode: 'rw' }],
        }
      },
      metadata: {
        serviceType: 'inference',
        containerId: containerName,
        port,
        gpuEnabled: gpuArgs.length > 0,
      }
    };

  } catch (error) {
    return {
      success: false,
      error: `Failed to start Ollama container: ${error}`,
      metadata: { serviceType: 'inference' }
    };
  }
};

function detectNvidiaGpu(): boolean {
  try {
    execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

const preflightInferenceStart = async (context: ContainerStartHandlerContext): Promise<PreflightResult> => {
  const serviceConfig = context.service.config as InferenceServiceConfig;
  const port = serviceConfig.port || OLLAMA_DEFAULT_PORT;
  return preflightFromChecks([
    checkContainerRuntime(context.runtime),
    await checkPortFree(port),
  ]);
};

export const inferenceStartDescriptor: HandlerDescriptor<ContainerStartHandlerContext, StartHandlerResult> = {
  command: 'start',
  platform: 'container',
  serviceType: 'inference',
  handler: startInference,
  preflight: preflightInferenceStart,
};
