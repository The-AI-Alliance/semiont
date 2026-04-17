/**
 * Worker Pool Main — standalone entry point
 *
 * Reads configuration from ~/.semiontconfig (TOML). Authenticates
 * with the KS via shared secret. Starts the worker pool.
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
import { homedir } from 'os';
import { join } from 'path';
import type { components } from '@semiont/core';

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

const baseUrl = get('backend.publicURL') || 'http://localhost:4000';
const workerSecret = process.env.SEMIONT_WORKER_SECRET ?? '';
const healthPort = Number(get('workers.healthPort') || '9090');

const inferenceType = (get('workers.default.inference.type') || 'ollama') as InferenceClientConfig['type'];
const inferenceModel = get('workers.default.inference.model') || 'llama3.1';
const inferenceEndpoint = get(`inference.${inferenceType}.baseURL`) || 'http://localhost:11434';

const inferenceConfig: InferenceClientConfig = {
  type: inferenceType,
  model: inferenceModel,
  endpoint: inferenceEndpoint,
  ...(process.env.ANTHROPIC_API_KEY && { apiKey: process.env.ANTHROPIC_API_KEY }),
};

import { createProcessLogger } from './logger';

const logger = createProcessLogger('worker');

// ── Authenticate and start ────────────────────────────────────────────

async function authenticate(): Promise<string> {
  if (!workerSecret) {
    logger.warn('No SEMIONT_WORKER_SECRET set — using empty token');
    return '';
  }

  const response = await fetch(`${baseUrl}/api/tokens/worker`, {
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
  logger.info('Authenticating', { baseUrl });
  const token = await authenticate();
  logger.info('Authenticated');

  const inferenceClient = createInferenceClient(inferenceConfig, logger);
  const generator: Agent = {
    '@type': 'SoftwareAgent',
    name: `worker-pool / ${inferenceType} ${inferenceModel}`,
    worker: 'worker-pool',
    inferenceProvider: inferenceType,
    model: inferenceModel,
  };

  const vm = startWorkerProcess({
    baseUrl,
    token,
    jobTypes: ALL_JOB_TYPES,
    inferenceClient,
    generator,
    logger,
  });

  logger.info('Connected', { baseUrl, inferenceType, inferenceModel, inferenceEndpoint });

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

  const shutdown = () => {
    logger.info('Shutting down');
    vm.dispose();
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
