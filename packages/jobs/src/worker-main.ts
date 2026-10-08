/**
 * Worker Pool Main — standalone entry point
 *
 * One worker host runs N parallel worker processes, one per distinct
 * `(inferenceProvider, model)` configured in `~/.semiontconfig`. Each
 * authenticates as its own service account, then exchanges that at
 * `/api/tokens/agent` for *its* agent
 * identity, and that JWT is what the bus stamps onto every event the
 * process emits — so `_userId` on the bus and the `generator` on every
 * annotation refer to the same software peer.
 *
 * Multiple job types may share an inference engine; in that case they
 * share a worker process (and an agent identity). Different engines
 * mean different processes and different agents.
 *
 * Environment variables (only two):
 *   SEMIONT_OIDC_CLIENT_ID / _SECRET — this process's service account
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
import { createTomlConfigLoader, MARK_MOTIVATIONS, type EnvironmentConfig, type JobFilter } from '@semiont/core';
import { archivistContentReads } from '@semiont/content';

// ── Load config via the canonical TOML loader ─────────────────────────

const configPath = join(homedir(), '.semiontconfig');
const tomlReader = {
  readIfExists: (p: string): string | null => existsSync(p) ? readFileSync(p, 'utf-8') : null,
};
// Environment resolved by the loader from `[defaults] environment`
// (no project root here — global ~/.semiontconfig only).
const envConfig = createTomlConfigLoader(
  tomlReader,
  configPath,
  process.env,
  'worker',
)(null);

// Who serves each job, as the loader resolved it: keyed as a job description
// is, with every fallback already applied. A job no section serves is absent,
// and this worker does not claim it.
const served = (envConfig._metadata as (EnvironmentConfig['_metadata'] & {
  workers?: { mark?: Partial<Record<(typeof MARK_MOTIVATIONS)[number], ResolvedInference>>; yield?: ResolvedInference };
}) | undefined)?.workers;
if (!served) {
  throw new Error(
    'No worker inference config found in ~/.semiontconfig. ' +
      'Add at least [environments.<env>.workers.default.inference] with type = "..." and model = "...".',
  );
}

const gatewayPublicURL = envConfig.services?.gateway?.publicURL;
if (!gatewayPublicURL) {
  throw new Error('services.gateway.publicURL is required in ~/.semiontconfig');
}
const gatewayBaseUrl: string = gatewayPublicURL;

const issuerUrl = envConfig.services?.identity?.issuer;
if (!issuerUrl) {
  throw new Error('services.identity.issuer is required: a worker authenticates at the knowledge base\'s issuer');
}
const clientId = process.env.SEMIONT_OIDC_CLIENT_ID;
const clientSecret = process.env.SEMIONT_OIDC_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  throw new Error('SEMIONT_OIDC_CLIENT_ID and SEMIONT_OIDC_CLIENT_SECRET are required to authenticate as a service account');
}
/** This process's account. The agent DIDs it buys are per (provider, model). */
const credential = { issuer: issuerUrl, clientId, clientSecret };

// Bytes come from the Archivist, not the gateway: the Archivist alone mounts
// the knowledge base's tree. Resolved at module scope so a worker with no
// Archivist address — or no service-account credential to show it — dies here,
// while an operator is watching, rather than failing every detection job for
// the life of the process.
const contentReads = archivistContentReads(envConfig, credential);
const healthPort = 24100;

import { createProcessLogger } from '@semiont/observability/process-logger';

const logger = createProcessLogger('worker');

// ── Group jobs by (provider, model) ───────────────────────────────────
//
// Two jobs that point at the same inference (provider, model)
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

const serving: [JobFilter, ResolvedInference][] = [
  ...MARK_MOTIVATIONS.flatMap((motivation): [JobFilter, ResolvedInference][] => {
    const inference = served.mark?.[motivation];
    return inference ? [[{ jobType: 'mark', params: { motivation } }, inference]] : [];
  }),
  ...(served.yield ? [[{ jobType: 'yield' }, served.yield] satisfies [JobFilter, ResolvedInference]] : []),
];
const groups = new Map<string, AgentGroup>();
for (const [filter, inference] of serving) {
  const key = clientKey(inference);
  let group = groups.get(key);
  if (!group) {
    group = {
      inference,
      serves: [],
      client: createInferenceClient(toClientConfig(inference), logger),
    };
    groups.set(key, group);
  }
  group.serves.push(filter);
}

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
    baseUrl: gatewayBaseUrl,
    agents: Array.from(groups.values()).map((g) => ({
      provider: g.inference.type,
      model: g.inference.model,
      serves: g.serves,
    })),
  });

  const workers = await Promise.all(
    // The first agent reports every group's limits: the gateway delivers only
    // the first reply to a request, so one agent answers for the pool.
    Array.from(groups.values()).map((group, i, all) =>
      startAgentWorker({
        group, gatewayBaseUrl, credential, contentReads, logger,
        reportsLimitsOf: i === 0 ? all.map((g) => g.client) : [],
      }),
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
