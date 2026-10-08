/**
 * Worker Runtime — the importable half of the worker host.
 *
 * `worker-main.ts` is a process entrypoint (config at module scope,
 * `main()` at import) and therefore untestable by construction; everything
 * a unit test needs to reach lives here instead, fully parameterized — no
 * module-scope env reads, no side effects at import.
 *
 * The load-bearing contract this module owns: a worker's stamped identity is
 * the DID the `/api/tokens/agent` exchange MINTED for it, carried verbatim —
 * never re-derived from the URL the worker happens to dial: re-deriving gives
 * one logical agent two DIDs.
 */

import type { EventMap, JobFilter } from '@semiont/core';
import { startWorkerProcess } from './worker-process';
import type { DescriptorReadAwaits, GeneratedTextAwaits } from './worker-process';
import type { ConsultAnchoredTextAwaits } from './workers/detection/prepare-detection';
import { answerLimitsRequests, type InferenceClient, type LimitsSource } from '@semiont/inference';
import {
  replyChannelsFor,
  didToAgent,
  baseUrl,
  type BusOperationKey,
  type components,
  type Logger,
} from '@semiont/core';
import {
  HttpContentTransport,
  HttpTransport,
  JOB_CLAIM_CHANNELS,
  JOB_COMMIT_CHANNELS,
  SemiontClient,
  startAgentSession,
  type WorkerVitals,
} from '@semiont/sdk';
import type { ServiceAccountCredential } from '@semiont/core';
import type { WorkerConfig } from './worker-config';

type Agent = components['schemas']['Agent'];

/** One agent identity: who it is, the jobs it serves, and the inference client it runs them on. */
export interface AgentGroup {
  /** The provider and the model: with the knowledge base's domain, the agent's identity. */
  agent: WorkerConfig['agents'][number]['agent'];
  serves: JobFilter[];
  client: InferenceClient;
}

export interface WorkerRuntimeOptions {
  group: AgentGroup;
  /** The gateway URL this worker dials — connection topology ONLY, never identity. */
  gatewayBaseUrl: string;
  /** This process's own account at the issuer. */
  credential: ServiceAccountCredential;
  logger: Logger;
  /**
   * The clients whose limits this agent reports on `job:limits-requested`:
   * every group's, for the one agent that answers for its pool, and none for
   * the rest. The gateway delivers only the first reply to a request.
   */
  reportsLimitsOf: readonly LimitsSource[];
}

/** Per-agent liveness: what the agent's claims say of themselves, plus this agent's identity. */
export interface AgentVitals extends WorkerVitals {
  provider: string;
  model: string;
  did: string;
  serves: JobFilter[];
}

export interface AgentWorkerHandle {
  client: SemiontClient;
  vitals(): AgentVitals;
  dispose(): Promise<void>;
}

export interface WorkerHealthPayload {
  status: 'ok';
  agents: number;
  workers: AgentVitals[];
}

/**
 * The `/health` body. Its consumers (image HEALTHCHECK, compose
 * `service_healthy`, `semiont start`) read `status`/`agents`; the per-agent
 * vitals expose claim-loop progress so a stalled worker is *visible*, not
 * just alive.
 */
export function buildHealthPayload(workers: ReadonlyArray<{ vitals(): AgentVitals }>): WorkerHealthPayload {
  return {
    status: 'ok',
    agents: workers.length,
    workers: workers.map((w) => w.vitals()),
  };
}

/**
 * The bus operations worker code itself AWAITS a reply to. Reply channels
 * are global fan-out on the gateway, so a full `BRIDGED_CHANNELS`
 * subscription makes every worker receive every other client's reply traffic
 * — measured at ~85 multi-MB `browse:annotations-result` frames/min, all
 * parsed and dropped by cid filtering, enough to OOM the worker. The worker
 * subscribes exactly its own operations' reply channels instead.
 *
 * This list restates a fact the code owns (which operations worker code
 * paths call `busRequest` on); its gate is the build-time census below
 * (`workerAwaitCensus`): every awaiting site declares its operation next to
 * the call, and an operation awaited but missing here fails COMPILATION with
 * the operation named. `busRequest`'s `isSubscribed` probe remains the
 * runtime backstop for an await nobody declared — a loud `bus.unsubscribed`
 * at first use, never a silent 30 s timeout.
 * (What the SDK awaits is not here. `job:claim` is awaited in `job.claim`,
 * and `JOB_CLAIM_CHANNELS` is its reply channels and the two broadcasts a
 * worker reads. A held job's commit awaits `mark:commit`, and the question it
 * asks when one goes unacknowledged, and `JOB_COMMIT_CHANNELS` is their
 * reply channels. `WORKER_CHANNELS` is the union of all three.)
 */
export const WORKER_AWAITED_OPERATIONS = [
  'browse:resource-requested',
  // Canonical geometry for a geometry-bearing detection: the consult behind
  // `ConsultAnchoredText`, answered by the Smelter. A generation asks the same
  // of the PDF it has just yielded, to anchor its citations. Without it every
  // PDF detection job fails at the transport probe; the census below fails
  // the BUILD when this list and the declared awaits drift.
  'browse:anchored-text-requested',
] as const satisfies readonly BusOperationKey[];

/**
 * The requests a worker ANSWERS. It holds the inference credentials, so it is
 * the one service that can discover its models' limits from their providers.
 * One agent in a pool answers for all of them (`reportsLimitsOf`): only its
 * transport subscribes these, so no other agent receives a request it would
 * drop.
 */
export const WORKER_ANSWERED_OPERATIONS = [
  'job:limits-requested',
] as const satisfies readonly BusOperationKey[];

/**
 * The global SSE channel set for a worker's transport: the whole manifest,
 * stated once and passed at construction. Nothing widens it afterwards.
 */
// `replyChannelsFor` returns `EventName[]`; annotating this
// `readonly string[]` would throw that proof away and let a transport's
// channel roster be wider than the registry.
export const WORKER_CHANNELS: readonly (keyof EventMap)[] = [
  ...JOB_CLAIM_CHANNELS,
  // A unit may not advance until its annotations are on the record, so every
  // job that makes annotations commits: without these every commit fails
  // fast with `bus.unsubscribed`.
  ...JOB_COMMIT_CHANNELS,
  ...replyChannelsFor(WORKER_AWAITED_OPERATIONS),
];

/**
 * The build-time census gate.
 *
 * `WORKER_AWAITED_OPERATIONS` restates a fact the code owns — which
 * operations worker paths call `busRequest` on — and one of those calls
 * hides behind an injected seam (`ConsultAnchoredText` → the SDK), where no
 * grep and no runtime probe-before-shipping can see it. So every awaiting
 * site DECLARES its operation next to the call (the `*Awaits` aliases), the
 * declarations are assembled here, and this constant compiles ONLY when the
 * list and the declarations agree in BOTH directions. Drift fails the build
 * with the drifted operation named in the type error — at build time, not at
 * the first live job. `busRequest`'s `bus.unsubscribed` probe remains the
 * runtime backstop for an await nobody declared.
 */
type DeclaredWorkerAwaits =
  | DescriptorReadAwaits       // worker-process.ts — the resource descriptor read
  | GeneratedTextAwaits        // worker-process.ts — the text of a PDF just yielded
  | ConsultAnchoredTextAwaits; // prepare-detection.ts — canonical geometry

type WorkerAwaitCensusDrift =
  | Exclude<DeclaredWorkerAwaits, (typeof WORKER_AWAITED_OPERATIONS)[number]>
  | Exclude<(typeof WORKER_AWAITED_OPERATIONS)[number], DeclaredWorkerAwaits>;

export const workerAwaitCensus: [WorkerAwaitCensusDrift] extends [never]
  ? 'in-census'
  : WorkerAwaitCensusDrift = 'in-census';

export async function startAgentWorker(
  opts: WorkerRuntimeOptions,
): Promise<AgentWorkerHandle> {
  const { group, gatewayBaseUrl, credential, reportsLimitsOf, logger } = opts;
  const { agent: engine } = group;

  // The process signs in as the agent this group works as, and the session
  // keeps that token fresh for as long as the process runs.
  const agent = await startAgentSession({
    baseUrl: gatewayBaseUrl,
    credential,
    provider: engine.provider,
    model: engine.model,
    logger,
  });

  // The sign-in minted this worker's canonical DID (under the KB's own
  // domain) and we carry it VERBATIM — never re-derive identity from
  // the URL we happen to dial (which is connection topology only):
  // re-deriving gives one logical agent two DIDs.
  const generator: Agent = didToAgent(agent.did);

  const transport = new HttpTransport({
    baseUrl: baseUrl(gatewayBaseUrl),
    token$: agent.token$,
    tokenRefresher: agent.refresh,
    // Only the channels this process reads — not the full bridged set. See
    // WORKER_CHANNELS. The agent that reports its pool's limits also
    // subscribes the requests it answers.
    channels: reportsLimitsOf.length > 0 ? [...WORKER_CHANNELS, ...WORKER_ANSWERED_OPERATIONS] : WORKER_CHANNELS,
  });
  const client = new SemiontClient(transport, new HttpContentTransport(transport), transport);

  const claims = startWorkerProcess({
    client,
    accepts: group.serves,
    inferenceClient: group.client,
    generator,
    logger,
  });

  const limitsResponder = reportsLimitsOf.length > 0
    ? answerLimitsRequests(transport, 'job:limits-requested', reportsLimitsOf, logger)
    : undefined;

  logger.info('Agent ready', {
    did: agent.did,
    provider: engine.provider,
    model: engine.model,
    serves: group.serves,
  });

  return {
    client,
    vitals: () => ({
      provider: engine.provider,
      model: engine.model,
      did: agent.did,
      serves: group.serves,
      ...claims.vitals(),
    }),
    dispose: async () => {
      limitsResponder?.unsubscribe();
      // A job still held is failed before the client goes, so the queue
      // retries it now and does not wait for its sweep.
      await claims.stop();
      agent.stop();
      client.dispose();
    },
  };
}
