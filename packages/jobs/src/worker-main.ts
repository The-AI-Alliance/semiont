/**
 * Worker Pool Main — standalone entry point
 *
 * Reads configuration from ~/.semiontconfig (TOML) via the canonical
 * `createTomlConfigLoader` from @semiont/core. Authenticates with the
 * KS via shared secret. Starts the worker process on top of a
 * `SemiontSession` so every HTTP call and bus emit goes through the
 * api-client, not raw `fetch`.
 *
 * One inference client is built per distinct `(type, model, apiKey,
 * endpoint)` combination declared in `[workers.<type>.inference]` /
 * `[workers.default.inference]`, and each job type dispatches to the
 * client configured for it.
 *
 * Environment variables (only two):
 *   SEMIONT_WORKER_SECRET — shared secret for JWT auth with the KS
 *   ANTHROPIC_API_KEY     — only when using Anthropic inference
 *
 * Everything else comes from ~/.semiontconfig.
 */

import { startWorkerProcess, type WorkerEngine } from './worker-process';
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
  type components,
  type EnvironmentConfig,
} from '@semiont/core';
import {
  HttpContentTransport,
  HttpTransport,
  InMemorySessionStorage,
  SemiontClient,
  SemiontSession,
  kbBackendUrl,
  setStoredSession,
  type KnowledgeBase,
} from '@semiont/api-client';
import { baseUrl, type AccessToken } from '@semiont/core';
import { BehaviorSubject } from 'rxjs';

type Agent = components['schemas']['Agent'];

const ALL_JOB_TYPES = [
  'reference-annotation', 'generation', 'highlight-annotation',
  'assessment-annotation', 'comment-annotation', 'tag-annotation',
];

// Shape of each resolved worker inference entry under `_metadata.workers`.
// The canonical TOML loader populates this by merging the per-worker
// inference block with the flat `[inference.<type>]` provider section
// (apiKey, endpoint/baseURL), so every entry here has everything a
// client factory needs.
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

// `_metadata.workers` is the resolver's output — a `WorkerInferenceConfig`
// keyed by job type (plus `default`) with each entry fully merged with
// the flat `[inference.<type>]` provider block.
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

import { createProcessLogger } from './logger';

const logger = createProcessLogger('worker');

// ── Build engines map with per-(type,model,apiKey,endpoint) de-dup ────

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

const clientCache = new Map<string, InferenceClient>();
const engines: Record<string, WorkerEngine> = {};
for (const jobType of ALL_JOB_TYPES) {
  const w = resolveWorker(jobType);
  const key = clientKey(w);
  let client = clientCache.get(key);
  if (!client) {
    client = createInferenceClient(toClientConfig(w), logger);
    clientCache.set(key, client);
  }
  const generator: Agent = {
    '@type': 'SoftwareAgent',
    name: `worker-pool / ${w.type} ${w.model}`,
    worker: 'worker-pool',
    inferenceProvider: w.type,
    model: w.model,
  };
  engines[jobType] = { inferenceClient: client, generator };
}

// ── Build a synthetic KB for the worker ──────────────────────────────
//
// SemiontSession is KB-scoped: every session is tied to one backend
// instance identified by protocol/host/port. Workers aren't user-
// scoped, but they are backend-scoped — they connect to exactly one
// Semiont backend. Represent that as a synthetic KnowledgeBase whose
// `email` carries the worker's service-principal identity.

function parseBackendUrl(url: string): { protocol: 'http' | 'https'; host: string; port: number } {
  const parsed = new URL(url);
  const protocol = (parsed.protocol.replace(':', '') === 'https' ? 'https' : 'http') as 'http' | 'https';
  const host = parsed.hostname;
  const port = parsed.port
    ? Number(parsed.port)
    : protocol === 'https' ? 443 : 80;
  return { protocol, host, port };
}

// ── Authenticate: exchange shared secret for a JWT ────────────────────

async function authenticate(): Promise<string> {
  if (!workerSecret) {
    logger.warn('No SEMIONT_WORKER_SECRET set — using empty token');
    return '';
  }

  const response = await fetch(`${backendBaseUrl}/api/tokens/worker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: workerSecret }),
  });

  if (!response.ok) {
    throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
  }

  const { token } = await response.json() as { token: string };
  return token;
}

async function main() {
  logger.info('Authenticating', { baseUrl: backendBaseUrl });
  const initialToken = await authenticate();
  logger.info('Authenticated');

  // Construct a synthetic KB + pre-seed an in-memory storage with the
  // initial token so SemiontSession starts with a ready-to-use token$.
  // The `refresh` callback re-exchanges the shared secret on expiry.
  const { protocol, host, port } = parseBackendUrl(backendBaseUrl);
  const kbId = `worker-${hostname()}`;
  const kb: KnowledgeBase = {
    id: kbId,
    label: `Worker pool @ ${host}`,
    host,
    port,
    protocol,
    email: `worker-pool@${host}`,
  };
  const storage = new InMemorySessionStorage();
  setStoredSession(storage, kbId, { access: initialToken, refresh: '' });

  const token$ = new BehaviorSubject<AccessToken | null>(null);
  let session!: SemiontSession;
  const transport = new HttpTransport({
    baseUrl: baseUrl(kbBackendUrl(kb)),
    token$,
    tokenRefresher: () => session.refresh().then((t) => t ?? null),
  });
  const content = new HttpContentTransport(transport);
  const client = new SemiontClient(transport, content);
  session = new SemiontSession({
    kb,
    storage,
    client,
    token$,
    refresh: async () => {
      try {
        return await authenticate();
      } catch (err) {
        logger.error('Worker token refresh failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
    // No validate callback — workers are service principals with no
    // user record to fetch. `session.user$` stays null.
    onError: (err) => {
      logger.error('Session error', { code: err.code, message: err.message });
    },
  });
  await session.ready;

  const workerVm = startWorkerProcess({
    session,
    jobTypes: ALL_JOB_TYPES,
    engines,
    logger,
  });

  logger.info('Connected', {
    baseUrl: backendBaseUrl,
    engines: Object.fromEntries(
      Object.entries(engines).map(([jt, e]) => [jt, `${e.generator.inferenceProvider} / ${e.generator.model}`]),
    ),
  });

  const health = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
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
    workerVm.dispose();
    await session.dispose();
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
