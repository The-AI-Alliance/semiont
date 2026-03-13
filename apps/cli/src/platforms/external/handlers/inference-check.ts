import { ExternalCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import type { InferenceServiceConfig } from '@semiont/core';
import { checkEnvVarResolved, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import Anthropic from '@anthropic-ai/sdk';

const SUPPORTED_TYPES = ['anthropic', 'ollama'] as const;

/**
 * Check handler for external inference services (Claude, Ollama, etc.)
 */
const checkExternalInference = async (context: ExternalCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service } = context;
  const serviceConfig = service.config as InferenceServiceConfig;
  const inferenceType = serviceConfig.type;

  if (!inferenceType) {
    return {
      success: false,
      error: 'Inference service type not configured. Set "type" in service configuration.',
      status: 'unknown',
      metadata: { serviceType: 'inference' }
    };
  }

  if (!SUPPORTED_TYPES.includes(inferenceType as typeof SUPPORTED_TYPES[number])) {
    return {
      success: false,
      error: `Unsupported inference type: "${inferenceType}". Supported types: ${SUPPORTED_TYPES.join(', ')}`,
      status: 'unknown',
      metadata: { serviceType: 'inference', inferenceType, supportedTypes: [...SUPPORTED_TYPES] }
    };
  }

  const endpoint = serviceConfig.endpoint;
  const model = serviceConfig.model;

  if (!endpoint) {
    return {
      success: false,
      error: 'No endpoint configured for inference service',
      status: 'unknown',
      metadata: { serviceType: 'inference', inferenceType }
    };
  }

  if (!model) {
    return {
      success: false,
      error: 'No model configured for inference service',
      status: 'unknown',
      metadata: { serviceType: 'inference', inferenceType }
    };
  }

  try {
    const startTime = Date.now();
    let responsePreview: string | undefined;
    let status: 'running' | 'stopped' | 'unhealthy' | 'unknown' = 'unknown';

    if (inferenceType === 'anthropic') {
      const result = await checkAnthropic(serviceConfig, endpoint, model);
      status = result.status;
      responsePreview = result.responsePreview;
    } else if (inferenceType === 'ollama') {
      const result = await checkOllama(endpoint, model);
      status = result.status;
      responsePreview = result.responsePreview;
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
    return handleCheckError(error, inferenceType, endpoint, model);
  }
};

async function checkAnthropic(
  serviceConfig: InferenceServiceConfig,
  endpoint: string,
  model: string,
): Promise<{ status: 'running'; responsePreview?: string }> {
  let apiKey: string | undefined = serviceConfig.apiKey;

  if (apiKey && apiKey.startsWith('${') && apiKey.endsWith('}')) {
    const envVarName = apiKey.slice(2, -1);
    apiKey = process.env[envVarName];
  }

  if (!apiKey) {
    throw new Error('Anthropic API key not configured. Set apiKey in service config.');
  }

  const client = new Anthropic({ apiKey, baseURL: endpoint });

  const response = await client.messages.create({
    model,
    max_tokens: 10,
    messages: [{ role: 'user', content: 'Respond with "OK" if operational.' }],
  });

  const responsePreview = response.content[0]?.type === 'text'
    ? response.content[0].text.substring(0, 50)
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
  const models = data.models || [];
  const modelNames = models.map((m) => m.name);

  // Ollama model names may include tag suffix (e.g. "gemma2:9b" or "gemma2:latest")
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
  let health: { healthy: boolean; details: Record<string, any> };

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
  const serviceConfig = context.service.config as InferenceServiceConfig;
  const checks = [
    checkEnvVarResolved(serviceConfig.endpoint, 'endpoint'),
    checkEnvVarResolved(serviceConfig.model, 'model'),
  ];

  // Only check API key for providers that require it
  if (serviceConfig.type !== 'ollama') {
    checks.push(checkEnvVarResolved(serviceConfig.apiKey, 'API key'));
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
