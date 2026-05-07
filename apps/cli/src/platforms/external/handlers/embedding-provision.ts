import { ExternalProvisionHandlerContext, ProvisionHandlerResult, HandlerDescriptor } from './types.js';
import { printInfo, printSuccess } from '../../../core/io/cli-logger.js';
import { EmbeddingService } from '../../../services/embedding-service.js';
import { preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult, PreflightCheck } from '../../../core/handlers/types.js';

/**
 * Provision handler for external embedding services.
 * For Ollama: pulls the embedding model via POST /api/pull.
 * For Voyage: no-op (cloud service, no model to pull).
 */
const provisionEmbedding = async (context: ExternalProvisionHandlerContext): Promise<ProvisionHandlerResult> => {
  const { service } = context;
  const embeddingService = service as EmbeddingService;
  const embeddingType = embeddingService.getEmbeddingType();

  if (embeddingType !== 'ollama') {
    return {
      success: true,
      metadata: { serviceType: 'embedding', embeddingType, skipped: true }
    };
  }

  const model = embeddingService.getModel();
  const baseUrl = embeddingService.getBaseURL().replace(/\/+$/, '');

  if (!service.quiet) {
    printInfo(`Pulling embedding model ${model} from ${baseUrl}...`);
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
      error: `Failed to pull embedding model ${model}: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`,
      metadata: { serviceType: 'embedding', embeddingType, model }
    };
  }

  const data = await res.json() as { status: string };
  if (data.status !== 'success') {
    return {
      success: false,
      error: `Unexpected pull status for ${model}: ${data.status}`,
      metadata: { serviceType: 'embedding', embeddingType, model }
    };
  }

  if (!service.quiet) {
    printSuccess(`Embedding model ${model} pulled successfully`);
  }

  return {
    success: true,
    resources: {
      platform: 'external',
      data: { endpoint: baseUrl, provider: embeddingType }
    },
    metadata: {
      serviceType: 'embedding',
      embeddingType,
      model,
      endpoint: baseUrl,
    }
  };
};

function checkEndpointReachable(endpoint: string): PreflightCheck {
  return {
    name: 'Embedding endpoint reachable',
    pass: true,
    message: `Will pull model from ${endpoint}`,
  };
}

const preflightEmbeddingProvision = async (context: ExternalProvisionHandlerContext): Promise<PreflightResult> => {
  const embeddingService = context.service as EmbeddingService;
  const embeddingType = embeddingService.getEmbeddingType();

  if (embeddingType !== 'ollama') {
    return preflightFromChecks([]);
  }

  return preflightFromChecks([
    checkEndpointReachable(embeddingService.getBaseURL()),
  ]);
};

export const embeddingProvisionDescriptor: HandlerDescriptor<ExternalProvisionHandlerContext, ProvisionHandlerResult> = {
  command: 'provision',
  platform: 'external',
  serviceType: 'embedding',
  handler: provisionEmbedding,
  preflight: preflightEmbeddingProvision,
};
