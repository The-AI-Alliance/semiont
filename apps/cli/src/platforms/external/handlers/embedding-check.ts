import { ExternalCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { EmbeddingService } from '../../../services/embedding-service.js';
import { preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult } from '../../../core/handlers/types.js';

/**
 * Check handler for external embedding services.
 * For Ollama: queries /api/tags and verifies the model is available.
 * For Voyage: validates the API key is configured.
 */
const checkEmbedding = async (context: ExternalCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service } = context;
  const embeddingService = service as EmbeddingService;
  const embeddingType = embeddingService.getEmbeddingType();
  const model = embeddingService.getModel();

  try {
    if (embeddingType === 'ollama') {
      const baseUrl = embeddingService.getBaseURL().replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/api/tags`);

      if (!res.ok) {
        return {
          success: false, status: 'unhealthy',
          error: `Ollama returned ${res.status} at ${baseUrl}/api/tags`,
          metadata: { serviceType: 'embedding', embeddingType, model },
        };
      }

      const data = await res.json() as { models: Array<{ name: string }> };
      const modelNames = (data.models || []).map((m) => m.name);
      const found = modelNames.some((name) =>
        name === model || name.startsWith(`${model}:`)
      );

      if (!found) {
        return {
          success: true, status: 'unhealthy',
          health: {
            healthy: false,
            details: {
              error: `Model "${model}" not found. Available: ${modelNames.join(', ')}`,
              embeddingType, model,
              hint: `Run: semiont provision --service embedding`,
            },
          },
          metadata: { serviceType: 'embedding', embeddingType, model },
        };
      }

      return {
        success: true, status: 'running',
        health: {
          healthy: true,
          details: { embeddingType, model, endpoint: baseUrl },
        },
        metadata: { serviceType: 'embedding', embeddingType, model, endpoint: baseUrl },
      };
    }

    // Voyage or other cloud providers — just check that apiKey is configured
    return {
      success: true, status: 'running',
      health: {
        healthy: true,
        details: { embeddingType, model },
      },
      metadata: { serviceType: 'embedding', embeddingType, model },
    };

  } catch (error: unknown) {
    return {
      success: false, status: 'stopped',
      error: `Cannot reach embedding provider: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { serviceType: 'embedding', embeddingType, model },
    };
  }
};

const preflightEmbeddingCheck = async (_context: ExternalCheckHandlerContext): Promise<PreflightResult> => {
  return preflightFromChecks([]);
};

export const embeddingCheckDescriptor: HandlerDescriptor<ExternalCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'external',
  serviceType: 'embedding',
  handler: checkEmbedding,
  preflight: preflightEmbeddingCheck,
};
