/**
 * Make-Meaning Service
 *
 * Provides a clean interface:
 *   const makeMeaning = await startMakeMeaning(project, config, eventBus, logger);
 */

import { STALL_THRESHOLD_MS } from '@semiont/jobs';
import { createEventStore as createEventStoreCore, type EventStore } from '@semiont/event-sourcing';
import type { SemiontProject } from '@semiont/core/node';
import { EventBus, withDeadline, type Logger } from '@semiont/core';
import { registerVectorIndexSizeProvider } from '@semiont/observability';
import { resolveActorInference, type MakeMeaningConfig } from './config';
import { createInferenceClient } from '@semiont/inference';
import { getGraphDatabase } from '@semiont/graph';
import { createKnowledgeBase, workingTreeContentReads } from './knowledge-base';
import { GRAPH_BARRIER_BUDGET_MS } from './graph-context';
import { Gatherer } from './gatherer';
import { Matcher } from './matcher';
import { Stower } from './stower';
import { Browser } from './browser';
import { wireEnrichment } from './event-enrichment';
import { CloneTokenManager } from './clone-token-manager';
import { bootstrapEntityTypes } from './bootstrap/entity-types';
import { stopKnowledgeSystem, type KnowledgeSystem } from './knowledge-system';
import { registerBusHandlers } from './handlers';
import { registerRetrievalHandlers } from './handlers/resource-retrieval';
import { anchoredTextOverBus } from './anchored-text-ask';
import { asBusRequestPrimitive } from './bus-request-local';

export type { MakeMeaningConfig } from './config';

export interface MakeMeaningService {
  knowledgeSystem: KnowledgeSystem;
  stop:            () => Promise<void>;
}

// ─── Step helpers ─────────────────────────────────────────────────────────────

/**
 * How long a boot waits for a dependency, and why exiting is the right end.
 *
 * Docker's `restart: on-failure` only rescues a process that EXITS; an unbounded
 * await on a slow dependency hangs forever and the container sits unhealthy.
 * On a Codespaces resume every container restarts at once and `depends_on`
 * does not apply — it governs `compose up`, not daemon-driven restarts — so
 * connects can reach Neo4j/Qdrant/Ollama before they are listening.
 *
 * 60s is this fleet's answer, not a general one, which is why it lives here and
 * `withDeadline` lives in core. It can be raced by work that retries — the
 * embedding provider waits ~5 min — and that is safe because `withDeadline` hands
 * the deadline down: the retry stops when this fires instead of being abandoned
 * mid-flight.
 */
export const STARTUP_CONNECT_TIMEOUT_MS = 60_000;

/** Operator context core cannot know: something is watching for the exit. */
export const RESTART_HINT =
  'Exiting so the container restart policy can retry — it is normal for a dependency ' +
  'to be slow when every service restarts at once.';

/**
 * Connect the shared stores both composition roots in this file need: graph,
 * event store, vectors + embedding, and the KnowledgeBase bundle. Whether
 * views REBUILD here is the root's call: each passes its caller's
 * `skipRebuild`, and without it the views rebuild from the event log.
 */
async function connectStores(
  project: SemiontProject,
  config: MakeMeaningConfig,
  eventBus: EventBus,
  logger: Logger,
  skipRebuild: boolean,
) {
  const graphConfig = config.services!.graph!;
  // Each connect is announced before it is attempted: when one of them does
  // hang, the last line in the log names the culprit.
  logger.info('Connecting to graph database', { type: graphConfig.type });
  const graphDb = await withDeadline('Graph database', STARTUP_CONNECT_TIMEOUT_MS,
    () => getGraphDatabase(graphConfig), RESTART_HINT);
  const eventStore = createEventStoreCore(project, eventBus, logger.child({ component: 'event-store' }));

  // The vector pair is mandatory and explicitly configured: construction
  // is unconditional — the config NAMES the store and the provider, or the
  // type (and the TOML loader before it) already refused. No fallback path
  // exists; a `memory` choice is an informed one and announces its
  // rebuild-on-restart cost below.
  const vectorsConfig = config.services.vectors;
  const embeddingConfig = config.services.embedding;
  const { createVectorStore, createEmbeddingProvider } = await import('@semiont/vectors');
  logger.info('Connecting to embedding provider', { type: embeddingConfig.type, model: embeddingConfig.model });
  const embeddingProvider = await withDeadline(
    'Embedding provider', STARTUP_CONNECT_TIMEOUT_MS,
    () => createEmbeddingProvider(embeddingConfig), RESTART_HINT,
  );
  logger.info('Connecting to vector store', { type: vectorsConfig.type });
  const vectorStore = await withDeadline(
    'Vector store', STARTUP_CONNECT_TIMEOUT_MS,
    (signal) => createVectorStore({
      // The deadline this call is already being raced against, handed down so
      // the dimension-probe retry stops when it fires instead of being abandoned
      // mid-flight. This is the whole point of the signal parameter.
      signal,
      type: vectorsConfig.type,
      host: vectorsConfig.host,
      port: vectorsConfig.port,
      // Dimensionality is discovered from the provider, so it is passed as a
      // thunk rather than probed here: the store calls it only if it needs it
      // (Qdrant, and only to CREATE a collection). This matches how inference
      // treats provider-derived facts — the client is built with no I/O and
      // `limits()` are discovered at the point of use — instead of making a
      // network round-trip a precondition of booting. A `memory` store, or a
      // Qdrant whose collections already exist, never consults the provider.
      dimensions: () => embeddingProvider.dimensions(),
    }),
    RESTART_HINT,
  );
  if (vectorsConfig.type === 'memory') {
    // L4 breadcrumb: the named cost of the named choice — this index lives
    // in process memory and the Smelter's reconcile re-embeds the whole KB
    // from the event log on every restart.
    // No `dimensions` here on purpose: logging it would resolve the thunk,
    // which is the eager provider probe the thunk exists to avoid.
    logger.info('memory vector store: the index rebuilds from the event log on every restart (reconcile re-embeds)');
  }
  logger.info('Vector search initialized', {
    store: vectorsConfig.type,
    embedding: embeddingConfig.type,
    model: embeddingConfig.model,
  });

  // Tier 3 observability: report index point count. Polled at the
  // metric-collection interval (default 30s).
  registerVectorIndexSizeProvider(() => vectorStore.count());

  const kb = await createKnowledgeBase(eventStore, project, graphDb, eventBus, logger, {
    vectorStore,
    skipRebuild,
  });

  return { kb, eventStore, embeddingProvider };
}

async function createKnowledgeSystemFromConfig(
  project: SemiontProject,
  kbDomain: string,
  config: MakeMeaningConfig,
  eventBus: EventBus,
  logger: Logger,
  skipRebuild?: boolean,
): Promise<KnowledgeSystem> {
  const { kb, eventStore, embeddingProvider } = await connectStores(project, config, eventBus, logger, skipRebuild ?? false);

  wireEnrichment(eventStore, kb);

  const stower = new Stower(kb, eventBus, project, logger.child({ component: 'stower' }));
  await stower.initialize();

  await bootstrapEntityTypes(eventBus, eventStore, kbDomain, logger.child({ component: 'entity-types-bootstrap' }));

  const gatherer = new Gatherer(
    // The content capability is ResourceId-keyed; in-process it wraps this
    // root's own working tree behind the transport shape.
    {
      ...kb,
      content: workingTreeContentReads(kb.views, kb.content),
      // Derived text rides the same bus read everywhere; in this root the
      // Browser answers in-process.
      anchoredText: anchoredTextOverBus(asBusRequestPrimitive(eventBus)),
    },
    eventBus,
    createInferenceClient(resolveActorInference(config, 'gatherer'), logger.child({ component: 'inference-client-gatherer' })),
    config.gather.settleTimeoutMs,
    logger.child({ component: 'gatherer' }),
    embeddingProvider,
  );
  await gatherer.initialize();

  const matcher = new Matcher(
    kb, eventBus,
    logger.child({ component: 'matcher' }),
    createInferenceClient(resolveActorInference(config, 'matcher'), logger.child({ component: 'inference-client-matcher' })),
    embeddingProvider,
  );
  await matcher.initialize();

  // Text search and referenced-by answer from the graph and the vectors, so
  // they register beside the two actors that hold them.
  const detachRetrieval = registerRetrievalHandlers(
    eventBus,
    { graph: kb.graph, views: kb.views, vectors: kb.vectors, content: workingTreeContentReads(kb.views, kb.content) },
    { embeddingProvider, semanticFloor: config.search.semanticFloor, state: project },
    logger,
  );

  const browser = new Browser(kb, eventBus, project, config, logger.child({ component: 'browser' }));
  await browser.initialize();

  const cloneTokenManager = new CloneTokenManager(kb, eventBus, logger.child({ component: 'clone-token-manager' }));
  await cloneTokenManager.initialize();

  const ks: KnowledgeSystem = {
    kb, stower, gatherer, matcher, browser, cloneTokenManager,
    stop: () => {
      detachRetrieval();
      return stopKnowledgeSystem(ks);
    },
  };
  return ks;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function assertMakeMeaningConfig(config: MakeMeaningConfig): void {
  if (!config.services?.graph) {
    throw new Error('services.graph is required for make-meaning service');
  }

  // Watchdog nesting: the gather's worst-case read-barrier spend — the
  // settle bound plus the graph barrier budget — must degrade gracefully
  // BEFORE the job-worker stall watchdog fails fast; a barrier that outlives
  // the watchdog gets the worker killed instead of a thin context. Enforced
  // here because both bounds are visible at this composition root; tighter
  // EXTERNAL watchdogs (e.g. my-chat's 90s generation stall) are not
  // importable and remain documented on the config field.
  if (!Number.isFinite(config.gather.settleTimeoutMs) || config.gather.settleTimeoutMs <= 0) {
    throw new Error(`gather.settleTimeoutMs must be a positive number of milliseconds, got ${config.gather.settleTimeoutMs}`);
  }
  if (config.gather.settleTimeoutMs + GRAPH_BARRIER_BUDGET_MS >= STALL_THRESHOLD_MS) {
    throw new Error(
      `gather.settleTimeoutMs (${config.gather.settleTimeoutMs}ms) plus the graph barrier budget (${GRAPH_BARRIER_BUDGET_MS}ms) ` +
      `must nest inside the job-worker stall watchdog (${STALL_THRESHOLD_MS}ms) — lower settleTimeoutMs`,
    );
  }
}

/**
 * The in-process composition root: every access actor and handler on one
 * caller-owned bus, for `LocalTransport` consumers — the SDK test seam and
 * embedding. Production composes the same actors as separate services
 * (archivist-main, librarian-main); this second root is supported in its own
 * right.
 * It runs no jobs: the job queue and the `job:*` channels are the
 * dispatcher's (apps/dispatcher), and a script that runs jobs runs the stack.
 */
export async function startMakeMeaning(
  project: SemiontProject,
  config: MakeMeaningConfig,
  eventBus: EventBus,
  logger: Logger,
  options?: { skipRebuild?: boolean },
): Promise<MakeMeaningService> {
  assertMakeMeaningConfig(config);

  // The knowledge base acts under its own identity: it seeds its default
  // entity types as `did:web:<domain>`.
  const kbDomain = project.siteDomain();
  if (!kbDomain) {
    throw new Error("The knowledge base's committed .semiont/config declares no [site] domain: it is the identity this knowledge base acts under");
  }

  const skipRebuild = options?.skipRebuild ?? (process.env.SEMIONT_SKIP_REBUILD === 'true');

  const knowledgeSystem = await createKnowledgeSystemFromConfig(project, kbDomain, config, eventBus, logger, skipRebuild);

  // Register the bus command handlers that translate caller-facing
  // request channels (mark:create-request, bind:update-body,
  // browse:annotation-context-requested, gather:summary-requested) into
  // the underlying make-meaning pipeline.
  registerBusHandlers(eventBus, knowledgeSystem, logger);

  return {
    knowledgeSystem,
    stop: async () => {
      logger.info('Stopping Make-Meaning service');
      await knowledgeSystem.stop();
      logger.info('Make-Meaning service stopped');
    },
  };
}

// ─── Record-maintenance composition root ──────────────────────────────────────

/**
 * The event log this root connects, plus its teardown. NOT a
 * `MakeMeaningService`: there are no actors and no bus handlers here, so
 * there is nothing to expose but the record itself.
 */
export interface MakeMeaningRecord {
  eventStore: EventStore;
  stop:       () => Promise<void>;
}

/**
 * The record-maintenance root: the shared stores (graph, event store, views,
 * content, vectors + embedding), and no actors and no bus command handlers.
 * An operator tool that only reads the event log and re-materializes views —
 * `rebuild-projections` — needs nothing more.
 */
export async function connectRecord(
  project: SemiontProject,
  config: MakeMeaningConfig,
  eventBus: EventBus,
  logger: Logger,
  options?: { skipRebuild?: boolean },
): Promise<MakeMeaningRecord> {
  assertMakeMeaningConfig(config);

  const skipRebuild = options?.skipRebuild ?? (process.env.SEMIONT_SKIP_REBUILD === 'true');
  const { kb } = await connectStores(project, config, eventBus, logger, skipRebuild);

  return {
    eventStore: kb.eventStore,
    // The store half of `stopKnowledgeSystem` — the same teardown, minus the
    // actors this root never built.
    stop: async () => {
      logger.info('Disconnecting make-meaning record');
      kb.weaveProgress.dispose();
      kb.smeltProgress.dispose();
      await kb.graph.disconnect();
    },
  };
}
