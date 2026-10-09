/**
 * Worker Pool Main — standalone entry point
 *
 * One worker host runs one agent for each entry of `agents` in its
 * configuration document: an inference provider and a model, and the jobs
 * that pair serves. Each signs in as this process's service account, then
 * exchanges that at `/api/tokens/agent` for *its* agent identity, and that
 * JWT is what the bus stamps onto every event the agent emits — so `_userId`
 * on the bus and the `generator` on every annotation refer to the same
 * software peer.
 *
 * What it is started with, and nothing else:
 *   --config <path>                   — its configuration document (WorkerConfig)
 *   SEMIONT_OIDC_CLIENT_ID / _SECRET  — this process's service account
 *   the variable an agent's `apiKeyEnv` names — that agent's provider key
 *
 * This file is deliberately a THIN shell: reading the document, making each
 * agent's inference client, and process lifecycle (health endpoint, signals).
 * What the document must say is `worker-config.ts`; the testable runtime —
 * authentication, identity adoption, session/worker wiring — is
 * `worker-runtime.ts`.
 */

import { startAgentWorker, buildHealthPayload, type AgentGroup } from './worker-runtime';
import { apiKeyOf, configPathOf, readWorkerConfig, serviceAccountOf } from './worker-config';
import { createInferenceClient } from '@semiont/inference';
import { createServer } from 'http';
import { createProcessLogger } from '@semiont/observability/process-logger';

/**
 * What ends the worker before it is up, said once on stderr as every service
 * says it: what it will not start on, and what it could not start with (a
 * sign-in the issuer refuses, a port it cannot listen on).
 */
function refuse(error: unknown): never {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

/**
 * Everything the worker is started with, read before anything is dialled: a
 * worker that cannot start says so while an operator is watching it boot.
 */
function boot() {
  const config = readWorkerConfig(configPathOf(process.argv.slice(2)));
  const logger = createProcessLogger('worker', { level: config.logLevel, format: config.logFormat });
  /** This process's account. The agent DIDs it buys are per (provider, model). */
  const credential = serviceAccountOf(config, process.env);
  const groups: AgentGroup[] = config.agents.map((entry, index) => {
    const apiKey = apiKeyOf(config, index, process.env);
    return {
      agent: entry.agent,
      serves: entry.accepts,
      client: createInferenceClient(
        { type: entry.agent.provider, model: entry.agent.model, baseURL: entry.baseUrl, ...(apiKey !== undefined ? { apiKey } : {}) },
        logger,
      ),
    };
  });
  return { config, logger, credential, groups };
}

let started: ReturnType<typeof boot>;
try {
  started = boot();
} catch (error) {
  refuse(error);
}
const { config, logger, credential, groups } = started;

async function main() {
  // Tier 2 observability — must come before any spanning code. No-op if
  // no OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_SDK_DISABLED=true).
  const { initObservabilityNode, registerSupervisorRestartCount } = await import('@semiont/observability/node');
  initObservabilityNode({ serviceName: 'semiont-worker' });
  // Supervised, but with no writable /semiont-state: `supervise.sh` keeps its
  // event log in /tmp and exports the resolved path. That is enough for the
  // LIVE count — the container does not exit when the child restarts — and
  // only surviving container teardown would need a mount, which was declined:
  // the death record does not outlive the container.
  registerSupervisorRestartCount();

  logger.info('Starting agents', {
    baseUrl: config.gatewayUrl,
    agents: groups.map((g) => ({
      provider: g.agent.provider,
      model: g.agent.model,
      serves: g.serves,
    })),
  });

  const workers = await Promise.all(
    // The first agent reports every group's limits: the gateway delivers only
    // the first reply to a request, so one agent answers for the pool.
    groups.map((group, i, all) =>
      startAgentWorker({
        group, gatewayBaseUrl: config.gatewayUrl, credential, logger,
        reportsLimitsOf: i === 0 ? all.map((g) => g.client) : [],
      }),
    ),
  );

  const health = createServer((req, res) => {
    // The path, without its query string; and GET alone.
    if (req.method === 'GET' && req.url?.split('?', 1)[0] === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildHealthPayload(workers)));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  health.once('error', (error) => refuse(new Error(`Cannot listen on port ${config.port}: ${error.message}`)));
  health.listen(config.port, () => {
    logger.info('Health endpoint ready', { port: config.port });
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

main().catch(refuse);
