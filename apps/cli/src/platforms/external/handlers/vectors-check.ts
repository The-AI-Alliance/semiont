/**
 * External Vectors (Qdrant) Check Handler
 *
 * Verifies connectivity to an external Qdrant instance
 * by hitting the /healthz endpoint.
 */

import { ExternalCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import { checkConfigField, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult, PreflightCheck } from '../../../core/handlers/types.js';

const checkVectorsService = async (context: ExternalCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service } = context;
  const config = service.config as { host?: string; port?: number; type?: string };

  const host = config.host ?? 'localhost';
  const port = config.port ?? 6333;
  const url = `http://${host}:${port}/healthz`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      return {
        success: true,
        status: 'running',
        metadata: {
          serviceType: 'vectors',
          host,
          port,
          type: config.type,
          endpoint: url,
        },
      };
    }

    return {
      success: false,
      status: 'unhealthy',
      error: `Qdrant returned ${response.status} at ${url}`,
      metadata: { serviceType: 'vectors', host, port },
    };
  } catch (error) {
    return {
      success: false,
      status: 'stopped',
      error: `Cannot reach Qdrant at ${url}: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { serviceType: 'vectors', host, port },
    };
  }
};

const preflightVectorsCheck = async (context: ExternalCheckHandlerContext): Promise<PreflightResult> => {
  const config = context.service.config as { host?: string; port?: number; type?: string };
  const checks: PreflightCheck[] = [
    checkConfigField(config.host, 'vectors.host'),
    checkConfigField(config.type, 'vectors.type'),
  ];
  return preflightFromChecks(checks);
};

export const vectorsCheckDescriptor: HandlerDescriptor<ExternalCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'external',
  serviceType: 'vectors',
  handler: checkVectorsService,
  preflight: preflightVectorsCheck,
};
