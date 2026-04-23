/**
 * Worker Pool Main — standalone entry point
 *
 * Reads configuration from ~/.semiontconfig (TOML). Authenticates
 * with the KS via shared secret. Starts the worker process on top
 * of a `SemiontSession` so every HTTP call and bus emit goes
 * through the api-client, not raw `fetch`.
 *
 * Environment variables (only two):
 *   SEMIONT_WORKER_SECRET — shared secret for JWT auth with the KS
 *   ANTHROPIC_API_KEY     — only when using Anthropic inference
 *
 * Everything else comes from ~/.semiontconfig.
 */

import { startWorkerProcess } from './worker-process';
import { createInferenceClient, type InferenceClientConfig } from '@semiont/inference';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { homedir, hostname } from 'os';
import { join } from 'path';
import { type components } from '@semiont/core';
import {
  SemiontSession,
  InMemorySessionStorage,
  setStoredSession,
  type KnowledgeBase,
} from '@semiont/api-client';

type Agent = components['schemas']['Agent'];

const ALL_JOB_TYPES = [
  'reference-annotation', 'generation', 'highlight-annotation',
  'assessment-annotation', 'comment-annotation', 'tag-annotation',
];

// ── Read semiontconfig ────────────────────────────────────────────────

function readSemiontConfig(): Record<string, string> {
  const configPath = join(homedir(), '.semiontconfig');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const result: Record<string, string> = {};
    let currentSection = '';
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '') continue;
      const sectionMatch = trimmed.match(/^\[(.+)]$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        continue;
      }
      const kvMatch = trimmed.match(/^(\w+)\s*=\s*"?([^"]*)"?$/);
      if (kvMatch) {
        const key = currentSection ? `${currentSection}.${kvMatch[1]}` : kvMatch[1];
        let value = kvMatch[2];
        value = value.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
          const sepIdx = expr.indexOf(':-');
          const varName = sepIdx >= 0 ? expr.slice(0, sepIdx) : expr;
          const defaultValue = sepIdx >= 0 ? expr.slice(sepIdx + 2) : '';
          return process.env[varName] ?? defaultValue;
        });
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

const config = readSemiontConfig();
const env = config['defaults.environment'] || 'local';
const get = (key: string): string => config[`environments.${env}.${key}`] ?? '';

const backendBaseUrl = get('backend.publicURL') || 'http://localhost:4000';
const workerSecret = process.env.SEMIONT_WORKER_SECRET ?? '';
const healthPort = Number(get('workers.healthPort') || '9090');

const inferenceType = (get('workers.default.inference.type') || 'ollama') as InferenceClientConfig['type'];
const inferenceModel = get('workers.default.inference.model') || 'llama3.1';
const inferenceEndpoint = get(`inference.${inferenceType}.baseURL`);
if (!inferenceEndpoint) {
  // No silent fallback — a missing/misspelled baseURL previously routed
  // every inference type to the ollama default, so an anthropic config
  // with the wrong key would point the Anthropic SDK at localhost:11434
  // and fail opaquely on the first job. Fail loudly at startup instead.
  throw new Error(
    `Missing inference.${inferenceType}.baseURL in ~/.semiontconfig — ` +
      `the worker needs an explicit endpoint for every inference type. ` +
      `Expected key: [environments.${env}.inference.${inferenceType}] baseURL = "..."`,
  );
}

const inferenceConfig: InferenceClientConfig = {
  type: inferenceType,
  model: inferenceModel,
  endpoint: inferenceEndpoint,
  ...(process.env.ANTHROPIC_API_KEY && { apiKey: process.env.ANTHROPIC_API_KEY }),
};

import { createProcessLogger } from './logger';

const logger = createProcessLogger('worker');

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

  const inferenceClient = createInferenceClient(inferenceConfig, logger);
  const generator: Agent = {
    '@type': 'SoftwareAgent',
    name: `worker-pool / ${inferenceType} ${inferenceModel}`,
    worker: 'worker-pool',
    inferenceProvider: inferenceType,
    model: inferenceModel,
  };

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

  const session = new SemiontSession({
    kb,
    storage,
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
    inferenceClient,
    generator,
    logger,
  });

  logger.info('Connected', {
    baseUrl: backendBaseUrl,
    inferenceType,
    inferenceModel,
    inferenceEndpoint,
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
