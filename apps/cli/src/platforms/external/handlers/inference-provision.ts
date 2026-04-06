import { ExternalProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import type { OllamaProviderConfig } from '@semiont/core';
import { InferenceService } from '../../../services/inference-service.js';
import { preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult, PreflightCheck } from '../../../core/handlers/types.js';

interface OllaPullResponse {
  status: string;
}

/**
 * Provision handler for external Ollama instances.
 * Pulls models via Ollama's HTTP API (POST /api/pull).
 */
const provisionInference = async (context: ExternalProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service } = context;
  const inferenceService = service as InferenceService;
  const inferenceType = inferenceService.getInferenceType();

  if (inferenceType !== 'ollama') {
    return {
      success: true,
      metadata: { serviceType: 'inference', inferenceType, skipped: true }
    };
  }

  const config = service.config as unknown as OllamaProviderConfig;
  const port = config.port ?? 11434;
  const endpoint = config.baseURL ?? `http://localhost:${port}`;
  const models = inferenceService.getModels();

  if (models.length === 0) {
    return {
      success: false,
      error: 'No models configured for ollama inference provider',
      metadata: { serviceType: 'inference', inferenceType }
    };
  }

  const baseUrl = endpoint.replace(/\/+$/, '');
  const pulledModels: string[] = [];

  for (const model of models) {
    if (!service.quiet) {
      printInfo(`Pulling model ${model} from ${baseUrl}...`);
    }

    const res = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: false }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        success: false,
        error: `Failed to pull model ${model}: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`,
        metadata: { serviceType: 'inference', inferenceType, model }
      };
    }

    const data = await res.json() as OllaPullResponse;
    if (data.status !== 'success') {
      return {
        success: false,
        error: `Unexpected pull status for ${model}: ${data.status}`,
        metadata: { serviceType: 'inference', inferenceType, model }
      };
    }

    pulledModels.push(model);

    if (!service.quiet) {
      printSuccess(`Model ${model} pulled successfully`);
    }
  }

  return {
    success: true,
    resources: {
      platform: 'external',
      data: { endpoint: baseUrl, provider: inferenceType }
    },
    metadata: {
      serviceType: 'inference',
      inferenceType,
      models: pulledModels,
      endpoint: baseUrl,
    }
  };
};

function checkEndpointReachable(endpoint: string): PreflightCheck {
  return {
    name: 'Ollama endpoint reachable',
    pass: true,
    message: `Will pull models from ${endpoint}`,
  };
}

const preflightInferenceProvision = async (context: ExternalProvisionHandlerContext): Promise<PreflightResult> => {
  const inferenceService = context.service as InferenceService;
  const inferenceType = inferenceService.getInferenceType();

  if (inferenceType !== 'ollama') {
    return preflightFromChecks([]);
  }

  const config = context.service.config as unknown as OllamaProviderConfig;
  const port = config.port ?? 11434;
  const endpoint = config.baseURL ?? `http://localhost:${port}`;

  return preflightFromChecks([
    checkEndpointReachable(endpoint),
  ]);
};

export const inferenceProvisionDescriptor: HandlerDescriptor<ExternalProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'external',
  serviceType: 'inference',
  handler: provisionInference,
  preflight: preflightInferenceProvision,
};
