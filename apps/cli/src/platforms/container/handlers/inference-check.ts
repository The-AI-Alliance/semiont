import { execFileSync } from 'child_process';
import { ContainerCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import type { InferenceServiceConfig } from '@semiont/core';
import { checkContainerRuntime, checkConfigField, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';

const OLLAMA_DEFAULT_PORT = 11434;

interface OllamaTagsResponse {
  models: Array<{ name: string }>;
}

const checkInference = async (context: ContainerCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service, runtime, containerName } = context;
  const serviceConfig = service.config as InferenceServiceConfig;
  const model = serviceConfig.model;
  const port = serviceConfig.port || OLLAMA_DEFAULT_PORT;
  const endpoint = `http://localhost:${port}`;

  let status: 'running' | 'stopped' | 'unhealthy' | 'unknown' = 'stopped';
  let containerId: string | undefined;
  let modelAvailable = false;

  // Check container status
  try {
    const containerStatus = execFileSync(
      runtime, ['inspect', containerName, '--format', '{{.State.Status}}'],
      { encoding: 'utf-8', stdio: 'pipe' }
    ).trim();

    if (containerStatus === 'running') {
      containerId = execFileSync(
        runtime, ['inspect', containerName, '--format', '{{.Id}}'],
        { encoding: 'utf-8', stdio: 'pipe' }
      ).trim();

      status = 'running';
    }
  } catch {
    // Container doesn't exist
  }

  // If running, check API and model availability
  if (status === 'running') {
    try {
      const res = await fetch(`${endpoint}/api/tags`);
      if (res.ok) {
        const data = await res.json() as OllamaTagsResponse;
        const models = data.models || [];
        const modelNames = models.map((m) => m.name);

        if (model) {
          modelAvailable = modelNames.some((name) =>
            name === model || name.startsWith(`${model}:`) || model.startsWith(`${name.split(':')[0]}:`)
          );
        }
      } else {
        status = 'unhealthy';
      }
    } catch {
      status = 'unhealthy';
    }
  }

  // Collect container logs
  let logs: { recent: string[]; errors: string[] } | undefined;
  if (containerId) {
    try {
      const output = execFileSync(
        runtime, ['logs', '--tail', '10', containerName],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const lines = output.split('\n').filter((l) => l.trim());
      logs = {
        recent: lines,
        errors: lines.filter((l) => l.toLowerCase().includes('error')),
      };
    } catch {
      // Can't collect logs
    }
  }

  return {
    success: true,
    status,
    platformResources: containerId ? {
      platform: 'container',
      data: {
        id: containerName,
        containerId,
        ports: { '11434': String(port) },
      }
    } : undefined,
    health: {
      healthy: status === 'running',
      details: {
        port,
        endpoint,
        model,
        modelAvailable,
        containerName,
        status: status === 'running' ? 'accepting connections' : 'not running',
      }
    },
    logs,
    metadata: {
      serviceType: 'inference',
      model,
      modelAvailable,
      stateVerified: true,
    }
  };
};

const preflightInferenceCheck = async (context: ContainerCheckHandlerContext) => {
  const config = context.service.config as InferenceServiceConfig;
  return preflightFromChecks([
    checkContainerRuntime(context.runtime),
    checkConfigField(config.model, 'inference.model'),
  ]);
};

export const inferenceCheckDescriptor: HandlerDescriptor<ContainerCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'container',
  serviceType: 'inference',
  handler: checkInference,
  preflight: preflightInferenceCheck,
};
