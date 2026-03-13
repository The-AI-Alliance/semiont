import { execFileSync } from 'child_process';
import { ContainerProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import type { InferenceServiceConfig } from '@semiont/core';
import { checkContainerRuntime, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult, PreflightCheck } from '../../../core/handlers/types.js';

const OLLAMA_IMAGE = 'ollama/ollama';
const VOLUME_NAME = 'semiont-ollama-models';

const provisionInference = async (context: ContainerProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service, runtime, containerName } = context;
  const serviceConfig = service.config as InferenceServiceConfig;
  const model = serviceConfig.model;
  const image = serviceConfig.image || OLLAMA_IMAGE;

  if (!model) {
    return {
      success: false,
      error: 'No model configured for inference service',
      metadata: { serviceType: 'inference' }
    };
  }

  // Pull the image
  if (!service.quiet) {
    printInfo(`Pulling ${image}...`);
  }

  try {
    execFileSync(runtime, ['pull', image], {
      stdio: service.quiet ? 'ignore' : 'inherit',
    });
  } catch (error) {
    return {
      success: false,
      error: `Failed to pull image ${image}: ${error}`,
      metadata: { serviceType: 'inference', image }
    };
  }

  // Create named volume for model cache
  try {
    execFileSync(runtime, ['volume', 'create', VOLUME_NAME], {
      stdio: 'ignore',
    });
  } catch {
    // Volume may already exist — that's fine
  }

  // Pull the model inside a temporary container
  if (!service.quiet) {
    printInfo(`Pulling model ${model} (this may take several minutes)...`);
  }

  try {
    execFileSync(runtime, [
      'run', '--rm',
      '-v', `${VOLUME_NAME}:/root/.ollama`,
      image,
      'pull', model,
    ], {
      stdio: service.quiet ? 'ignore' : 'inherit',
      timeout: 600_000, // 10 minutes for large model pulls
    });
  } catch (error) {
    return {
      success: false,
      error: `Failed to pull model ${model}: ${error}`,
      metadata: { serviceType: 'inference', model, image }
    };
  }

  if (!service.quiet) {
    printSuccess(`Model ${model} pulled successfully`);
  }

  return {
    success: true,
    resources: {
      platform: 'container',
      data: {
        id: containerName,
        containerId: '',
        imageName: image,
        volumeId: VOLUME_NAME,
      }
    },
    metadata: {
      serviceType: 'inference',
      model,
      image,
      volume: VOLUME_NAME,
    }
  };
};

function detectGpu(runtime: 'docker' | 'podman'): PreflightCheck {
  try {
    const output = execFileSync(runtime, ['info', '--format', '{{.Runtimes}}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (output.includes('nvidia')) {
      return { name: 'GPU detection', pass: true, message: 'NVIDIA container runtime detected — GPU passthrough available' };
    }
  } catch {
    // Can't detect runtimes
  }

  // Check for NVIDIA GPU directly
  try {
    const gpuName = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (gpuName) {
      return { name: 'GPU detection', pass: true, message: `NVIDIA GPU detected (${gpuName}) — ensure nvidia-container-toolkit is installed for GPU passthrough` };
    }
  } catch {
    // No NVIDIA
  }

  return { name: 'GPU detection', pass: true, message: 'No GPU detected — CPU-only inference in container' };
}

const preflightInferenceProvision = async (context: ContainerProvisionHandlerContext): Promise<PreflightResult> => {
  return preflightFromChecks([
    checkContainerRuntime(context.runtime),
    detectGpu(context.runtime),
  ]);
};

export const inferenceProvisionDescriptor: HandlerDescriptor<ContainerProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'container',
  serviceType: 'inference',
  handler: provisionInference,
  preflight: preflightInferenceProvision,
};
