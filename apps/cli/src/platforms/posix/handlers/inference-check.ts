import { StateManager } from '../../../core/state-manager.js';
import { PosixCheckHandlerContext, CheckHandlerResult, HandlerDescriptor } from './types.js';
import type { InferenceServiceConfig } from '@semiont/core';
import { checkConfigField, preflightFromChecks } from '../../../core/handlers/preflight-utils.js';

const OLLAMA_DEFAULT_PORT = 11434;

interface OllamaTagsResponse {
  models: Array<{ name: string }>;
}

const checkInference = async (context: PosixCheckHandlerContext): Promise<CheckHandlerResult> => {
  const { platform, service } = context;
  const serviceConfig = service.config as InferenceServiceConfig;
  const model = serviceConfig.model;
  const port = serviceConfig.port || OLLAMA_DEFAULT_PORT;
  const endpoint = `http://localhost:${port}`;

  let status: 'running' | 'stopped' | 'unhealthy' | 'unknown' = 'stopped';
  let pid: number | undefined;
  let modelAvailable = false;

  // Check saved state for PID
  const savedState = await StateManager.load(
    service.projectRoot,
    service.environment,
    service.name
  );

  if (savedState?.resources?.platform === 'posix' &&
      savedState.resources.data.pid &&
      StateManager.isProcessRunning(savedState.resources.data.pid)) {
    pid = savedState.resources.data.pid;
  }

  // Check if Ollama is responding
  try {
    const res = await fetch(`${endpoint}/api/tags`);
    if (res.ok) {
      status = 'running';
      const data = await res.json() as OllamaTagsResponse;
      const models = data.models || [];
      const modelNames = models.map((m) => m.name);

      if (model) {
        modelAvailable = modelNames.some((name) =>
          name === model || name.startsWith(`${model}:`) || model.startsWith(`${name.split(':')[0]}:`)
        );
      }
    }
  } catch {
    status = 'stopped';
  }

  const platformResources = pid ? {
    platform: 'posix' as const,
    data: { pid, port }
  } : undefined;

  // Collect logs if running
  let logs: { recent: string[]; errors: string[] } | undefined;
  if (status === 'running' && platform && typeof platform.collectLogs === 'function') {
    const logEntries = await platform.collectLogs(service, { tail: 10 });
    if (logEntries) {
      logs = {
        recent: logEntries.map(entry => entry.message),
        errors: logEntries.filter(entry => entry.level === 'error').map(entry => entry.message),
      };
    }
  }

  return {
    success: true,
    status,
    platformResources,
    health: {
      healthy: status === 'running',
      details: {
        port,
        endpoint,
        model,
        modelAvailable,
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

const preflightInferenceCheck = async (context: PosixCheckHandlerContext) => {
  const config = context.service.config as InferenceServiceConfig;
  return preflightFromChecks([
    checkConfigField(config.model, 'inference.model'),
  ]);
};

export const inferenceCheckDescriptor: HandlerDescriptor<PosixCheckHandlerContext, CheckHandlerResult> = {
  command: 'check',
  platform: 'posix',
  serviceType: 'inference',
  handler: checkInference,
  preflight: preflightInferenceCheck,
};
