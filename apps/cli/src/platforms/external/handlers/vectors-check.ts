/**
 * External Vectors (Qdrant) Check Handler
 *
 * Verifies connectivity to an external Qdrant instance
 * by hitting the /healthz endpoint.
 */

import { preflightFromChecks } from '../../../core/handlers/preflight-utils.js';
import type { PreflightResult, PreflightCheck, CheckHandlerResult } from '../../../core/handlers/types.js';
import type { ExternalCheckHandlerContext, HandlerDescriptor } from './types.js';

const checkVectorsService = async (context: ExternalCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { service } = context;
  const config = service.config as { host?: string; port?: number; type?: string };

  const host = config.host ?? 'localhost';
  const port = config.port ?? 6333;
  const url = `http://${host}:${port}/healthz`;

  const checks: PreflightCheck[] = [];

  // Check configuration
  checks.push({
    name: 'vectors-host',
    pass: !!config.host,
    message: config.host ? `vectors host: ${config.host}` : 'vectors host not configured',
  });

  checks.push({
    name: 'vectors-type',
    pass: config.type === 'qdrant' || config.type === 'memory',
    message: `vectors type: ${config.type ?? 'not set'}`,
  });

  // Check connectivity
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      checks.push({
        name: 'vectors-connectivity',
        pass: true,
        message: `Qdrant reachable at ${url}`,
      });
    } else {
      checks.push({
        name: 'vectors-connectivity',
        pass: false,
        message: `Qdrant returned ${response.status} at ${url}`,
      });
    }
  } catch (error) {
    checks.push({
      name: 'vectors-connectivity',
      pass: false,
      message: `Cannot reach Qdrant at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const preflight = preflightFromChecks(checks);
  const healthy = checks.every(c => c.pass);

  return {
    success: healthy,
    metadata: {
      serviceType: 'vectors',
      status: healthy ? 'running' : 'unhealthy',
      health: { healthy },
      host,
      port,
      type: config.type,
    },
  };
};

export const vectorsCheckHandler: HandlerDescriptor<ExternalCheckHandlerContext, CheckHandlerResult> = {
  serviceType: 'vectors',
  capability: 'check',
  handler: checkVectorsService,
};
