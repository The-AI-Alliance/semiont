/**
 * Worker Runtime — the importable half of the worker host.
 *
 * `worker-main.ts` is a process entrypoint (config at module scope,
 * `main()` at import) and therefore untestable by construction; everything
 * a unit test needs to reach lives here instead, fully parameterized — no
 * module-scope env reads, no side effects at import.
 *
 * The load-bearing contract this module owns (and the reason it was
 * extracted): a worker's stamped identity is the DID the
 * `/api/tokens/agent` exchange MINTED for it, carried verbatim — never
 * re-derived from the URL the worker happens to dial. One logical agent
 * previously got two DIDs that way (.plans/bugs/agent-did-host-skew.md).
 */

import { startWorkerProcess } from './worker-process';
import type { WorkerVitals } from './job-claim-adapter';
import type { InferenceClient } from '@semiont/inference';
import { hostname } from 'os';
import {
  didToAgent,
  baseUrl,
  retryWithBackoff,
  isTransientFetchError,
  STARTUP_FETCH_RETRY,
  type RetryPolicy,
  type components,
  type Logger,
  type AccessToken,
} from '@semiont/core';
import {
  InMemorySessionStorage,
  SemiontClient,
  SemiontSession,
  kbBackendUrl,
  setStoredSession,
  type HttpEndpoint,
  type KnowledgeBase,
} from '@semiont/sdk';
import { HttpContentTransport, HttpTransport } from '@semiont/http-transport';
import { BehaviorSubject } from 'rxjs';

type Agent = components['schemas']['Agent'];

/** Shape of each resolved worker inference entry under `_metadata.workers`. */
export type ResolvedInference = {
  type: 'anthropic' | 'ollama';
  model: string;
  apiKey?: string;
  endpoint?: string;
  baseURL?: string;
};

/** One agent identity: an inference engine and the job types it serves. */
export interface AgentGroup {
  inference: ResolvedInference;
  jobTypes: string[];
  client: InferenceClient;
}

export interface WorkerRuntimeOptions {
  group: AgentGroup;
  /** The backend URL this worker dials — connection topology ONLY, never identity. */
  backendBaseUrl: string;
  /** Shared secret for `/api/tokens/agent`. */
  workerSecret: string;
  logger: Logger;
}

/** Per-agent liveness: the adapter's snapshot plus this agent's identity. */
export interface AgentVitals extends WorkerVitals {
  provider: string;
  model: string;
  did: string;
  jobTypes: string[];
}

export interface AgentWorkerHandle {
  session: SemiontSession;
  vitals(): AgentVitals;
  dispose(): Promise<void>;
}

export interface WorkerHealthPayload {
  status: 'ok';
  agents: number;
  workers: AgentVitals[];
}

/**
 * The `/health` body (WORKER-LIVENESS.md P1). Additive: existing
 * consumers (image HEALTHCHECK, compose `service_healthy`, start.sh)
 * keep reading `status`/`agents`; the per-agent vitals expose
 * claim-loop progress so a stalled worker is *visible*, not just alive.
 */
export function buildHealthPayload(workers: ReadonlyArray<{ vitals(): AgentVitals }>): WorkerHealthPayload {
  return {
    status: 'ok',
    agents: workers.length,
    workers: workers.map((w) => w.vitals()),
  };
}

/**
 * Stall watchdog (WORKER-LIVENESS.md P3) — the fail-fast line behind the
 * inference timeout. There is no poll loop to heartbeat; the honest
 * stall signal in this push-driven architecture is *processing without
 * activity*: an agent holding a claimed job whose `lastActivityAt`
 * (claim / progress / finish) has stopped advancing is wedged — the
 * adapter ignores every announcement while `isProcessing`, so a wedged
 * agent never recovers on its own. Silent hang → loud crash → whatever
 * restart policy the deployment chose.
 *
 * Thresholds are fixed by design (no env knobs) and deliberately
 * layered: inference timeout (10 min, P2) fires first; this watchdog
 * (15 min) catches the failure modes nobody predicted; the backend's
 * dead-worker janitor (30 min) re-queues the job regardless.
 */
export const STALL_THRESHOLD_MS = 15 * 60_000;
export const STALL_CHECK_INTERVAL_MS = 60_000;

export interface StallWatchdogOptions {
  workers: ReadonlyArray<{ vitals(): AgentVitals }>;
  logger: Logger;
  /** Test seam; defaults to process.exit. */
  exit?: (code: number) => void;
}

export function startStallWatchdog(opts: StallWatchdogOptions): { dispose(): void } {
  const { workers, logger, exit = (code: number) => process.exit(code) } = opts;

  const timer = setInterval(() => {
    const now = Date.now();
    for (const worker of workers) {
      const v = worker.vitals();
      if (!v.activeJob || !v.lastActivityAt) continue;

      const silentForMs = now - Date.parse(v.lastActivityAt);
      if (silentForMs <= STALL_THRESHOLD_MS) continue;

      logger.error('Worker stalled — exiting for restart', {
        provider: v.provider,
        model: v.model,
        did: v.did,
        jobId: v.activeJob.jobId,
        jobType: v.activeJob.type,
        processingSince: v.activeJob.since,
        lastActivityAt: v.lastActivityAt,
        silentForMs,
        thresholdMs: STALL_THRESHOLD_MS,
      });
      clearInterval(timer);
      exit(1);
      return;
    }
  }, STALL_CHECK_INTERVAL_MS);
  timer.unref?.();

  return { dispose: () => clearInterval(timer) };
}

export function parseBackendUrl(url: string): { protocol: 'http' | 'https'; host: string; port: number } {
  const parsed = new URL(url);
  const protocol = (parsed.protocol.replace(':', '') === 'https' ? 'https' : 'http') as 'http' | 'https';
  const host = parsed.hostname;
  const port = parsed.port
    ? Number(parsed.port)
    : protocol === 'https' ? 443 : 80;
  return { protocol, host, port };
}

/**
 * Exchange the worker secret for this agent's JWT and its canonical DID.
 * The DID is minted by the backend (from its `site.domain`) — the caller
 * carries it verbatim.
 *
 * Connection-level failures (`TypeError: fetch failed`) are retried with
 * exponential backoff: the backend may be mid-restart or the container
 * network still warming up when this process starts, and orchestration
 * runs workers with `--rm` and no restart policy — exiting on the first
 * failed fetch is permanent death. HTTP-level rejections (401 on a bad
 * secret) are NOT retried; the backend is up and said no.
 */
export async function authenticateAgent(opts: {
  backendBaseUrl: string;
  workerSecret: string;
  provider: string;
  model: string;
  logger?: Logger;
  retry?: RetryPolicy;
}): Promise<{ token: string; did: string }> {
  const { backendBaseUrl, workerSecret, provider, model, logger, retry = STARTUP_FETCH_RETRY } = opts;
  if (!workerSecret) {
    throw new Error('SEMIONT_WORKER_SECRET is required to authenticate worker agents');
  }

  return retryWithBackoff(
    async () => {
      const response = await fetch(`${backendBaseUrl}/api/tokens/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: workerSecret, provider, model }),
      });

      if (!response.ok) {
        throw new Error(`Agent authentication failed for ${provider}:${model}: ${response.status} ${response.statusText}`);
      }

      return await response.json() as { token: string; did: string };
    },
    isTransientFetchError,
    retry,
    ({ attempt, attempts, delayMs, error }) => {
      logger?.warn('Backend unreachable, retrying agent authentication', {
        agent: `${provider}:${model}`,
        attempt,
        attempts,
        retryInMs: delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

export async function startAgentWorker(
  opts: WorkerRuntimeOptions,
): Promise<AgentWorkerHandle> {
  const { group, backendBaseUrl, workerSecret, logger } = opts;
  const { inference } = group;

  const { protocol, host, port } = parseBackendUrl(backendBaseUrl);
  const { token: initialToken, did } = await authenticateAgent({
    backendBaseUrl,
    workerSecret,
    provider: inference.type,
    model: inference.model,
    logger,
  });

  // The exchange minted this worker's canonical DID (from the backend's
  // site.domain) and we carry it VERBATIM — never re-derive identity from
  // the URL we happen to dial (`host` is connection topology only). One
  // logical agent previously got two DIDs this way:
  // .plans/bugs/agent-did-host-skew.md.
  const generator: Agent = didToAgent(did);

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
        const { token } = await authenticateAgent({
          backendBaseUrl,
          workerSecret,
          provider: inference.type,
          model: inference.model,
          logger,
        });
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
    vitals: () => ({
      provider: inference.type,
      model: inference.model,
      did,
      jobTypes: group.jobTypes,
      ...adapter.vitals(),
    }),
    dispose: async () => {
      adapter.dispose();
      await session.dispose();
    },
  };
}
