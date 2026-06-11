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
 */

import { startWorkerProcess } from './worker-process';
import {
  createInferenceClient,
  type InferenceClient,
  type InferenceClientConfig,
} from '@semiont/inference';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { homedir, hostname } from 'os';
import { join } from 'path';
import {
  createTomlConfigLoader,
  softwareToAgent,
  type components,
  type EnvironmentConfig,
} from '@semiont/core';
import { InMemorySessionStorage, SemiontClient, SemiontSession, kbBackendUrl, setStoredSession, type HttpEndpoint, type KnowledgeBase } from '@semiont/sdk';
import { HttpContentTransport, HttpTransport } from '@semiont/http-transport';
import { baseUrl, type AccessToken } from '@semiont/core';
import { BehaviorSubject } from 'rxjs';

type Agent = components['schemas']['Agent'];

const ALL_JOB_TYPES = [
  'reference-annotation', 'generation', 'highlight-annotation',
  'assessment-annotation', 'comment-annotation', 'tag-annotation',
];

// Shape of each resolved worker inference entry under `_metadata.workers`.
type ResolvedInference = {
  type: 'anthropic' | 'ollama';
  model: string;
  apiKey?: string;
  endpoint?: string;
  baseURL?: string;
};

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

interface AgentGroup {
  inference: ResolvedInference;
  jobTypes: string[];
  client: InferenceClient;
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

// ── KB shape used for sessions ────────────────────────────────────────

function parseBackendUrl(url: string): { protocol: 'http' | 'https'; host: string; port: number } {
  const parsed = new URL(url);
  const protocol = (parsed.protocol.replace(':', '') === 'https' ? 'https' : 'http') as 'http' | 'https';
  const host = parsed.hostname;
  const port = parsed.port
    ? Number(parsed.port)
    : protocol === 'https' ? 443 : 80;
  return { protocol, host, port };
}

// ── Authenticate one agent identity ──────────────────────────────────

async function authenticateAgent(provider: string, model: string): Promise<{ token: string; did: string }> {
  if (!workerSecret) {
    throw new Error('SEMIONT_WORKER_SECRET is required to authenticate worker agents');
  }

  const response = await fetch(`${backendBaseUrl}/api/tokens/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: workerSecret, provider, model }),
  });

  if (!response.ok) {
    throw new Error(`Agent authentication failed for ${provider}:${model}: ${response.status} ${response.statusText}`);
  }

  return await response.json() as { token: string; did: string };
}

async function startAgentWorker(group: AgentGroup): Promise<{ session: SemiontSession; dispose: () => Promise<void> }> {
  const { inference } = group;

  const { protocol, host, port } = parseBackendUrl(backendBaseUrl);
  const { token: initialToken, did } = await authenticateAgent(inference.type, inference.model);

  const generator: Agent = softwareToAgent({
    domain: host,
    provider: inference.type,
    model: inference.model,
  });

  const kbId = `agent-${inference.type}-${inference.model}-${hostname()}`;
  const endpoint: HttpEndpoint = { kind: 'http', host, port, protocol };
  const kb: KnowledgeBase = {
    id: kbId,
    label: `${inference.type} / ${inference.model} @ ${host}`,
    email: `agent@${host}`,
    endpoint,
  };
  const storage = new InMemorySessionStorage();
  setStoredSession(storage, kbId, { access: initialToken, refresh: '' });

  const token$ = new BehaviorSubject<AccessToken | null>(null);
  let session!: SemiontSession;
  const transport = new HttpTransport({
    baseUrl: baseUrl(kbBackendUrl(endpoint)),
    token$,
    tokenRefresher: () => session.refresh().then((t) => t ?? null),
  });
  const content = new HttpContentTransport(transport);
  const client = new SemiontClient(transport, content, transport);
  session = new SemiontSession({
    kb,
    storage,
    client,
    token$,
    refresh: async () => {
      try {
        const { token } = await authenticateAgent(inference.type, inference.model);
        return token;
      } catch (err) {
        logger.error('Agent token refresh failed', {
          error: err instanceof Error ? err.message : String(err),
          agent: did,
        });
        return null;
      }
    },
    onError: (err) => {
      logger.error('Session error', { code: err.code, message: err.message, agent: did });
    },
  });
  await session.ready;

  const adapter = startWorkerProcess({
    session,
    jobTypes: group.jobTypes,
    inferenceClient: group.client,
    generator,
    logger,
  });

  logger.info('Agent ready', {
    did,
    provider: inference.type,
    model: inference.model,
    jobTypes: group.jobTypes,
  });

  return {
    session,
    dispose: async () => {
      adapter.dispose();
      await session.dispose();
    },
  };
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

  const workers = await Promise.all(Array.from(groups.values()).map(startAgentWorker));

  const health = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', agents: workers.length }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  health.listen(healthPort, () => {
    logger.info('Health endpoint ready', { port: healthPort });
  });

  const shutdown = async () => {
    logger.info('Shutting down');
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
