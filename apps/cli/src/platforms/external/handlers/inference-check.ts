import { ExternalCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import type { OllamaProviderConfig, AnthropicProviderConfig } from '@semiont/core';
import { InferenceService } from '../../../services/inference-service.js';
import { checkEnvVarResolved, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';

/**
 * Check handler for external inference services (Anthropic, Ollama).
 * Branches on inferenceType from the InferenceService instance.
 */
const checkExternalInference = async (context: ExternalCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service } = context;
  const inferenceService = service as InferenceService;
  const inferenceType = inferenceService.getInferenceType();

  try {
    const startTime = Date.now();
    let responsePreview: string | undefined;
    let status: 'running' | 'stopped' | 'unhealthy' | 'unknown' = 'unknown';
    let endpoint: string;
    let model: string;

    if (inferenceType === 'anthropic') {
      const config = service.config as unknown as AnthropicProviderConfig;
      endpoint = config.endpoint ?? 'https://api.anthropic.com';
      const models = inferenceService.getModels();
      model = models[0] ?? '';

      if (!model) {
        return {
          success: false,
          error: 'No model configured for anthropic inference provider',
          status: 'unknown',
          metadata: { serviceType: 'inference', inferenceType }
        };
      }

      const result = await checkAnthropic(config, endpoint, model);
      status = result.status;
      responsePreview = result.responsePreview;

    } else if (inferenceType === 'ollama') {
      const config = service.config as unknown as OllamaProviderConfig;
      const port = config.port ?? 11434;
      endpoint = config.baseURL ?? `http://localhost:${port}`;
      const models = inferenceService.getModels();
      model = models[0] ?? '';

      if (!model) {
        return {
          success: false,
          error: 'No model configured for ollama inference provider',
          status: 'unknown',
          metadata: { serviceType: 'inference', inferenceType }
        };
      }

      const result = await checkOllama(endpoint, model);
      status = result.status;
      responsePreview = result.responsePreview;

    } else {
      return {
        success: false,
        error: `Unsupported inference type: "${inferenceType}"`,
        status: 'unknown',
        metadata: { serviceType: 'inference', inferenceType }
      };
    }

    const responseTime = Date.now() - startTime;

    return {
      success: true,
      status,
      health: {
        healthy: true,
        details: {
          status: 'healthy',
          inferenceType,
          model,
          endpoint,
          responseTime: `${responseTime}ms`,
          responsePreview,
        }
      },
      platformResources: {
        platform: 'external',
        data: { endpoint, provider: inferenceType }
      },
      metadata: { serviceType: 'inference', inferenceType, endpoint, model, stateVerified: true }
    };

  } catch (error: unknown) {
    const config = service.config as unknown as Record<string, unknown>;
    const endpoint = (config.endpoint ?? config.baseURL ?? '') as string;
    const models = (service as InferenceService).getModels();
    return handleCheckError(error, inferenceType, endpoint, models[0] ?? '');
  }
};

async function checkAnthropic(
  config: AnthropicProviderConfig,
  endpoint: string,
  model: string,
): Promise<{ status: 'running'; responsePreview?: string }> {
  let apiKey: string | undefined = config.apiKey;

  if (apiKey && apiKey.startsWith('${') && apiKey.endsWith('}')) {
    const envVarName = apiKey.slice(2, -1);
    apiKey = process.env[envVarName];
  }

  if (!apiKey) {
    throw new Error('Anthropic API key not configured. Set apiKey in inference provider config.');
  }

  const res = await fetch(`${endpoint}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Respond with "OK" if operational.' }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API error: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
  }

  const response = await res.json() as { content: Array<{ type: string; text?: string }> };
  const responsePreview = response.content[0]?.type === 'text'
    ? response.content[0].text?.substring(0, 50)
    : undefined;

  return { status: 'running', responsePreview };
}

interface OllamaTagsResponse {
  models: Array<{ name: string }>;
}

async function checkOllama(
  endpoint: string,
  model: string,
): Promise<{ status: 'running'; responsePreview?: string }> {
  const url = `${endpoint.replace(/\/+$/, '')}/api/tags`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Ollama server returned ${res.status}`);
  }

  const data = await res.json() as OllamaTagsResponse;
  const modelNames = (data.models || []).map((m) => m.name);

  const found = modelNames.some((name) =>
    name === model || name.startsWith(`${model}:`) || model.startsWith(`${name.split(':')[0]}:`)
  );

  if (!found) {
    throw Object.assign(
      new Error(`Model "${model}" not found. Available: ${modelNames.join(', ')}`),
      { status: 404 },
    );
  }

  return { status: 'running', responsePreview: `model ${model} available` };
}

function handleCheckError(
  error: unknown,
  inferenceType: string,
  endpoint: string,
  model: string,
): CheckHandlerResult {
  const err = error as Record<string, unknown>;
  const errorMessage = (err?.message as string) || 'Health check failed';
  const errorCode = err?.status as number | undefined;
  const errorType = (err?.error as Record<string, unknown>)?.type as string | undefined;
  const errorDetails = (err?.error as Record<string, unknown>)?.message as string | undefined;

  let status: 'running' | 'stopped' | 'unhealthy' | 'unknown' = 'unhealthy';
  let health: { healthy: boolean; details: Record<string, unknown> };

  if (errorCode === 401 || errorCode === 403 || errorMessage.includes('API key') || errorMessage.includes('Authentication')) {
    status = 'stopped';
    health = {
      healthy: false,
      details: {
        error: errorMessage, inferenceType, endpoint, model,
        hint: 'API key authentication failed',
        errorCode, errorType, errorDetails,
      }
    };
  } else if (errorCode === 429) {
    status = 'running';
    health = {
      healthy: true,
      details: { status: 'rate_limited', inferenceType, model, endpoint }
    };
  } else if (errorCode === 404 || errorMessage.includes('not found')) {
    status = 'stopped';
    health = {
      healthy: false,
      details: {
        error: `Model "${model}" not found or not accessible`,
        inferenceType, endpoint,
        hint: `Check if the model "${model}" is valid and accessible`,
        errorCode, errorType, errorDetails,
      }
    };
  } else {
    health = {
      healthy: false,
      details: {
        error: errorMessage, inferenceType, endpoint, model,
        hint: inferenceType === 'anthropic' ? 'Ensure apiKey is set and valid' : 'Ensure Ollama server is running',
        errorCode, errorType, errorDetails,
      }
    };
  }

  return {
    success: true,
    status,
    health,
    metadata: { serviceType: 'inference', inferenceType, endpoint, model, stateVerified: true }
  };
}

const preflightInferenceCheck = async (context: ExternalCheckHandlerContext) => {
  const inferenceService = context.service as InferenceService;
  const inferenceType = inferenceService.getInferenceType();
  const config = context.service.config as unknown as Record<string, unknown>;

  const checks = [];
  if (inferenceType === 'anthropic') {
    checks.push(checkEnvVarResolved(config.endpoint as string | undefined, 'endpoint'));
    checks.push(checkEnvVarResolved(config.apiKey as string | undefined, 'API key'));
  }

  return preflightFromChecks(checks);
};

export const inferenceCheckDescriptor: HandlerDescriptor<ExternalCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'external',
  serviceType: 'inference',
  handler: checkExternalInference,
  preflight: preflightInferenceCheck,
};
