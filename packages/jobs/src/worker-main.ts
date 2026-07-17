/**
 * Worker Pool Main — standalone entry point
 *
 * One worker host runs N parallel worker processes, one per distinct
 * `(inferenceProvider, model)` configured in `~/.semiontconfig`. Each
 * authenticates with the KS via `/api/tokens/agent` for *its* agent
 * identity, and that JWT is what the bus stamps onto every event the
 * process emits — so `_userId` on the bus and the `generator` on every
 * annotation refer to the same software peer.
 *
 * Multiple job types may share an inference engine; in that case they
 * share a worker process (and an agent identity). Different engines
 * mean different processes and different agents.
 *
 * Environment variables (only two):
 *   SEMIONT_WORKER_SECRET — shared secret for /api/tokens/agent auth
 *   ANTHROPIC_API_KEY     — only when using Anthropic inference
 *
 * Everything else comes from ~/.semiontconfig.
 *
 * This file is deliberately a THIN shell: config loading, group
 * composition, and process lifecycle (health endpoint, signals). The
 * testable runtime — authentication, identity adoption, session/worker
 * wiring — lives in `worker-runtime.ts`.
 */

import {
  startAgentWorker,
  buildHealthPayload,
  startStallWatchdog,
  type AgentGroup,
  type ResolvedInference,
} from './worker-runtime';
import {
  createInferenceClient,
  type InferenceClientConfig,
} from '@semiont/inference';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createTomlConfigLoader, type EnvironmentConfig } from '@semiont/core';

const ALL_JOB_TYPES = [
  'reference-annotation', 'generation', 'highlight-annotation',
  'assessment-annotation', 'comment-annotation', 'tag-annotation',
];

// ── Load config via the canonical TOML loader ─────────────────────────

const configPath = join(homedir(), '.semiontconfig');
const tomlReader = {
  readIfExists: (p: string): string | null => existsSync(p) ? readFileSync(p, 'utf-8') : null,
};
const envConfig = createTomlConfigLoader(
  tomlReader,
  configPath,
  process.env,
)(null, 'local');

const workerInferenceMap = (envConfig._metadata as (EnvironmentConfig['_metadata'] & {
  workers?: Record<string, ResolvedInference>;
}) | undefined)?.workers;
if (!workerInferenceMap || Object.keys(workerInferenceMap).length === 0) {
  throw new Error(
    'No worker inference config found in ~/.semiontconfig. ' +
      'Add at least [environments.<env>.workers.default.inference] with type = "..." and model = "...".',
  );
}

function resolveWorker(jobType: string): ResolvedInference {
  const specific = workerInferenceMap![jobType];
  if (specific) return specific;
  const def = workerInferenceMap!['default'];
  if (def) return def;
  throw new Error(
    `No inference config for worker '${jobType}' and no workers.default in ~/.semiontconfig.`,
  );
}

const backendPublicURL = envConfig.services?.backend?.publicURL;
if (!backendPublicURL) {
  throw new Error('services.backend.publicURL is required in ~/.semiontconfig');
}
const backendBaseUrl: string = backendPublicURL;

const workerSecret = process.env.SEMIONT_WORKER_SECRET ?? '';
const healthPort = 9090;

import { createProcessLogger } from '@semiont/observability/process-logger';

const logger = createProcessLogger('worker');

// ── Group job types by (provider, model) ──────────────────────────────
//
// Two job types that point at the same inference (provider, model)
// share the same software-agent identity, so they share one process.
// Different (provider, model) pairs mean different agents.

function clientKey(w: ResolvedInference): string {
  return [w.type, w.model, w.apiKey ?? '', w.endpoint ?? '', w.baseURL ?? ''].join('|');
}

function toClientConfig(w: ResolvedInference): InferenceClientConfig {
  return {
    type: w.type,
    model: w.model,
    ...(w.endpoint && { endpoint: w.endpoint }),
    ...(w.baseURL && { baseURL: w.baseURL }),
    ...(w.apiKey && { apiKey: w.apiKey }),
  };
}

const groups = new Map<string, AgentGroup>();
for (const jobType of ALL_JOB_TYPES) {
  const inference = resolveWorker(jobType);
  const key = clientKey(inference);
  let group = groups.get(key);
  if (!group) {
    group = {
      inference,
      jobTypes: [],
      client: createInferenceClient(toClientConfig(inference), logger),
    };
    groups.set(key, group);
  }
  group.jobTypes.push(jobType);
}

async function main() {
  // Tier 2 observability — must come before any spanning code. No-op if
  // no OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_SDK_DISABLED=true).
  const { initObservabilityNode } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-worker' });

  logger.info('Starting agents', {
    baseUrl: backendBaseUrl,
    agents: Array.from(groups.values()).map((g) => ({
      provider: g.inference.type,
      model: g.inference.model,
      jobTypes: g.jobTypes,
    })),
  });

  const workers = await Promise.all(
    Array.from(groups.values()).map((group) =>
      startAgentWorker({ group, backendBaseUrl, workerSecret, logger }),
    ),
  );

  const health = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildHealthPayload(workers)));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  health.listen(healthPort, () => {
    logger.info('Health endpoint ready', { port: healthPort });
  });

  // Fail fast on a wedged claim loop: a crashed container is visible,
  // diagnosable, and restartable; a silent zombie is none of those.
  const watchdog = startStallWatchdog({ workers, logger });

  const shutdown = async () => {
    logger.info('Shutting down');
    watchdog.dispose();
    await Promise.all(workers.map((w) => w.dispose()));
    health.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  logger.error('Fatal', { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  process.exit(1);
});
