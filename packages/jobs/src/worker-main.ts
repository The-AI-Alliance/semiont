/**
 * Worker Pool Main — standalone entry point
 *
 * Reads configuration from environment variables (inherited from parent
 * process or set explicitly) and starts the worker pool.
 *
 * Spawned by the backend as a child process, or run standalone via:
 *   node worker-main.js
 */

import { startWorkerProcess } from './worker-process';
import { createInferenceClient, type InferenceClientConfig } from '@semiont/inference';
import type { components } from '@semiont/core';

type Agent = components['schemas']['Agent'];
type InferenceType = InferenceClientConfig['type'];

const ALL_JOB_TYPES = [
  'reference-annotation', 'generation', 'highlight-annotation',
  'assessment-annotation', 'comment-annotation', 'tag-annotation',
];

const baseUrl = process.env.SEMIONT_KS_URL ?? 'http://localhost:4000';
const token = process.env.SEMIONT_WORKER_TOKEN ?? '';
const inferenceType = (process.env.SEMIONT_INFERENCE_PROVIDER ?? 'ollama') as InferenceType;
const inferenceEndpoint = process.env.SEMIONT_INFERENCE_URL ?? 'http://localhost:11434';
const inferenceModel = process.env.SEMIONT_INFERENCE_MODEL ?? 'llama3.1';
const inferenceApiKey = process.env.ANTHROPIC_API_KEY;

const inferenceConfig: InferenceClientConfig = {
  type: inferenceType,
  model: inferenceModel,
  endpoint: inferenceEndpoint,
  ...(inferenceApiKey && { apiKey: inferenceApiKey }),
};

const logger = {
  debug: () => {},
  info: (...args: unknown[]) => console.log('[worker]', ...args),
  warn: (...args: unknown[]) => console.warn('[worker]', ...args),
  error: (...args: unknown[]) => console.error('[worker]', ...args),
  child: () => logger,
};

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
});

console.log(`[worker] Worker pool started, connected to ${baseUrl}`);
console.log(`[worker] Inference: ${inferenceType} @ ${inferenceEndpoint}`);
console.log(`[worker] Job types: ${ALL_JOB_TYPES.join(', ')}`);

process.on('SIGTERM', () => {
  console.log('[worker] Received SIGTERM, shutting down...');
  vm.dispose();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[worker] Received SIGINT, shutting down...');
  vm.dispose();
  process.exit(0);
});
