/**
 * Weaver axiom harness (WEAVER-AXIOMS R0).
 *
 * Pure in-memory rig for the property suite: no EventStore, no filesystem,
 * no tmp dirs. Histories σ are generated arrays of StoredEvents; the
 * `browse:*` responders serve THEM (the Weaver's only view of history),
 * the reference fold `foldModel(σ)` is the independent oracle for the
 * differential axioms (deliberately sharing no code with any projection
 * under test), and the fault-injecting graph wrapper supplies the
 * schedules φ for the soundness axioms.
 *
 * Spec and ledger: `.plans/WEAVER-AXIOMS.md`.
 */

import { Subject } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { Annotation, EventMap, Logger, ResourceDescriptor, StoredEvent } from '@semiont/core';
import { MemoryGraphDatabase } from '@semiont/graph';
import type { GraphDatabase } from '@semiont/graph';
import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';
import { Weaver, type WeaverTiming } from '../../weaver';
import { asBusRequestPrimitive } from '../../bus-request-local';
import type { WeaverCheckpoint } from '../../weaver-checkpoint';

export const noopLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => noopLogger,
};

/** Generator-speed timings (SMELTER-AXIOMS D4 precedent). */
export const TIMING_FAST: WeaverTiming = {
  burstWindowMs: 1,
  maxBatchSize: 500,
  idleTimeoutMs: 2,
  drainTimeoutMs: 3_000,
  drainPollMs: 2,
  drainStallPolls: 50,
  checkpointFlushMs: 60_000, // flushes are explicit in the harness
};

export class MemoryWeaverCheckpoint implements WeaverCheckpoint {
  private map: Record<string, number> = {};
  async load(): Promise<Record<string, number>> { return { ...this.map }; }
  async save(applied: Record<string, number>): Promise<void> { this.map = { ...applied }; }
  seed(map: Record<string, number>): void { this.map = { ...map }; }
  snapshot(): Record<string, number> { return { ...this.map }; }
}

// ── Events ──────────────────────────────────────────────────────────────────

let eventCounter = 0;

export function storedEvent(
  type: string,
  rid: string | undefined,
  payload: unknown,
  seq: number,
): StoredEvent {
  return {
    id: `evt-${++eventCounter}`,
    type,
    timestamp: new Date().toISOString(),
    userId: 'did:web:test:users:axioms',
    ...(rid ? { resourceId: rid } : {}),
    version: 1,
    payload,
    metadata: { sequenceNumber: seq },
  } as unknown as StoredEvent;
}

export const makeAnnotationPayload = (aid: string, rid: string) => ({
  id: aid,
  motivation: 'commenting',
  target: { source: rid },
  body: [],
});

// ── The reference fold (the model M in W4/W5) ───────────────────────────────

export interface ModelResource {
  archived: boolean;
  tags: Set<string>;
  annotations: Set<string>;
}

export interface ModelState {
  resources: Map<string, ModelResource>;
  entityTypes: Set<string>;
}

export function foldModel(events: StoredEvent[]): ModelState {
  const resources = new Map<string, ModelResource>();
  // Every graph store seeds its registry with the ontology baseline
  // (MemoryGraphDatabase.initializeTagCollections and friends) — the model
  // starts from the same vocabulary; frame:entity-type-added adds on top.
  const entityTypes = new Set<string>(DEFAULT_ENTITY_TYPES);

  for (const e of events) {
    const rid = e.resourceId ? String(e.resourceId) : undefined;
    const payload = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'yield:created': {
        if (!rid) break;
        resources.set(rid, {
          archived: false,
          tags: new Set((payload.entityTypes as string[] | undefined) ?? []),
          annotations: new Set(),
        });
        break;
      }
      case 'mark:archived':
        if (rid) { const r = resources.get(rid); if (r) r.archived = true; }
        break;
      case 'mark:unarchived':
        if (rid) { const r = resources.get(rid); if (r) r.archived = false; }
        break;
      case 'mark:added': {
        if (!rid) break;
        const r = resources.get(rid);
        const ann = payload.annotation as { id: string } | undefined;
        if (r && ann?.id) r.annotations.add(String(ann.id));
        break;
      }
      case 'mark:removed': {
        if (!rid) break;
        const r = resources.get(rid);
        if (r && payload.annotationId) r.annotations.delete(String(payload.annotationId));
        break;
      }
      case 'mark:entity-tag-added': {
        if (!rid) break;
        const r = resources.get(rid);
        if (r && payload.entityType) r.tags.add(String(payload.entityType));
        break;
      }
      case 'mark:entity-tag-removed': {
        if (!rid) break;
        const r = resources.get(rid);
        if (r && payload.entityType) r.tags.delete(String(payload.entityType));
        break;
      }
      case 'frame:entity-type-added':
        if (payload.entityType) entityTypes.add(String(payload.entityType));
        break;
      // mark:body-updated: body contents are outside the v1 model scope
      // (identity + facets) — a deliberate boundary, see WEAVER-AXIOMS W9.
    }
  }

  return { resources, entityTypes };
}

// ── Normalized dumps (≡ in the axioms) ──────────────────────────────────────

export interface NormalizedDump {
  resources: Array<{ id: string; archived: boolean; tags: string[]; annotations: string[] }>;
  entityTypes: string[];
}

export function dumpModel(state: ModelState): NormalizedDump {
  return {
    resources: [...state.resources.entries()]
      .map(([id, r]) => ({
        id,
        archived: r.archived,
        tags: [...r.tags].sort(),
        annotations: [...r.annotations].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    entityTypes: [...state.entityTypes].sort(),
  };
}

export async function dumpGraph(db: GraphDatabase): Promise<NormalizedDump> {
  const { resources } = await db.listResources({ limit: 100_000 });
  const out: NormalizedDump['resources'] = [];
  for (const doc of resources) {
    const id = String(doc['@id']);
    const annotations = await db.getResourceAnnotations(makeResourceId(id));
    out.push({
      id,
      archived: doc.archived ?? false,
      tags: [...(doc.entityTypes ?? [])].sort(),
      annotations: annotations.map((a) => String(a.id)).sort(),
    });
  }
  return {
    resources: out.sort((a, b) => a.id.localeCompare(b.id)),
    entityTypes: [...(await db.getEntityTypes())].sort(),
  };
}

// ── Fault injection (the schedules φ) ───────────────────────────────────────

export interface FaultSchedule {
  /** Return true to fail this mutation. `key` is the op's primary id. */
  shouldFail(op: string, key: string): boolean;
}

export const NO_FAULTS: FaultSchedule = { shouldFail: () => false };

/** Fail exactly the mutations whose key is in `keys` (every attempt). */
export function failKeys(keys: Iterable<string>): FaultSchedule {
  const set = new Set(keys);
  return { shouldFail: (_op, key) => set.has(key) };
}

/** Fail each key's FIRST attempt only — the transient-fault shape. */
export function failKeysOnce(keys: Iterable<string>): FaultSchedule {
  const pending = new Set(keys);
  return {
    shouldFail: (_op, key) => {
      if (!pending.has(key)) return false;
      pending.delete(key);
      return true;
    },
  };
}

const MUTATIONS: Record<string, (args: unknown[]) => string[]> = {
  createResource: (a) => [String((a[0] as ResourceDescriptor)['@id'])],
  batchCreateResources: (a) => (a[0] as ResourceDescriptor[]).map((r) => String(r['@id'])),
  updateResource: (a) => [String(a[0])],
  deleteResource: (a) => [String(a[0])],
  createAnnotation: (a) => [String((a[0] as { id: string }).id)],
  createAnnotations: (a) => (a[0] as Array<{ id: string }>).map((i) => String(i.id)),
  updateAnnotation: (a) => [String(a[0])],
  deleteAnnotation: (a) => [String(a[0])],
  addEntityType: (a) => [String(a[0])],
  addEntityTypes: (a) => (a[0] as string[]).map(String),
};

export interface FaultingGraph {
  graph: GraphDatabase;
  injectedFailures: () => number;
}

/**
 * Wrap a graph store so mutations can fail per schedule. Reads pass
 * through untouched; a scheduled failure throws before the inner store is
 * touched, so a "failed" mutation never partially lands.
 */
export function faultingGraph(inner: GraphDatabase, schedule: FaultSchedule): FaultingGraph {
  let injected = 0;
  const graph = new Proxy(inner, {
    get(target, prop, receiver) {
      const name = String(prop);
      const keysOf = MUTATIONS[name];
      const original = Reflect.get(target, prop, receiver);
      if (!keysOf || typeof original !== 'function') {
        return typeof original === 'function' ? original.bind(target) : original;
      }
      return (...args: unknown[]) => {
        for (const key of keysOf(args)) {
          if (schedule.shouldFail(name, key)) {
            injected++;
            return Promise.reject(new Error(`injected fault: ${name}(${key})`));
          }
        }
        return (original as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as GraphDatabase;
  return { graph, injectedFailures: () => injected };
}

// ── Browse responders serving a generated history ───────────────────────────

/**
 * Serve `browse:resources-requested` (paged), `browse:events-requested`,
 * and `browse:annotations-requested` from a history σ — the harness stands
 * in for the Browser exactly where catch-up, rebuild, and reconcile read.
 * Annotations answer with the MODEL's current live set for the resource.
 */
export function serveHistory(eventBus: EventBus, history: StoredEvent[]): () => void {
  const byRid = new Map<string, StoredEvent[]>();
  for (const e of history) {
    if (!e.resourceId) continue;
    const rid = String(e.resourceId);
    const list = byRid.get(rid);
    if (list) list.push(e);
    else byRid.set(rid, [e]);
  }
  const rids = [...byRid.keys()];
  const model = foldModel(history);

  const subs = [
    eventBus.get('browse:resources-requested').subscribe((req) => {
      const offset = (req as { offset?: number }).offset ?? 0;
      const limit = (req as { limit?: number }).limit ?? 20;
      const page = rids.slice(offset, offset + limit).map((id) => {
        const m = model.resources.get(id);
        return {
          '@id': id,
          name: id,
          representations: [],
          archived: m?.archived ?? false,
          entityTypes: m ? [...m.tags] : [],
        };
      });
      eventBus.get('browse:resources-result').next({
        correlationId: (req as { correlationId: string }).correlationId,
        response: { resources: page, total: rids.length },
      } as unknown as EventMap['browse:resources-result']);
    }),
    eventBus.get('browse:events-requested').subscribe((req) => {
      const rid = String((req as { resourceId: string }).resourceId);
      const events = byRid.get(rid) ?? [];
      eventBus.get('browse:events-result').next({
        correlationId: (req as { correlationId: string }).correlationId,
        response: { events, total: events.length, resourceId: rid },
      } as unknown as EventMap['browse:events-result']);
    }),
    eventBus.get('browse:annotations-requested').subscribe((req) => {
      const rid = String((req as { resourceId: string }).resourceId);
      const live = model.resources.get(rid)?.annotations ?? new Set<string>();
      const annotations = [...live].map((aid) => makeAnnotationPayload(aid, rid)) as unknown as Annotation[];
      eventBus.get('browse:annotations-result').next({
        correlationId: (req as { correlationId: string }).correlationId,
        response: { annotations },
      } as unknown as EventMap['browse:annotations-result']);
    }),
  ];
  return () => subs.forEach((s) => s.unsubscribe());
}

// ── Weaver rig ───────────────────────────────────────────────────────────────

export interface WeaverRig {
  weaver: Weaver;
  graph: GraphDatabase;
  eventBus: EventBus;
  checkpoint: MemoryWeaverCheckpoint;
  push: (e: StoredEvent) => void;
  pushRebuild: (cmd: EventMap['weave:rebuild']) => void;
  dispose: () => Promise<void>;
}

export async function buildWeaverRig(opts?: {
  graph?: GraphDatabase;
  eventBus?: EventBus;
  checkpoint?: MemoryWeaverCheckpoint;
  timing?: WeaverTiming;
}): Promise<WeaverRig> {
  const graph = opts?.graph ?? new MemoryGraphDatabase();
  const eventBus = opts?.eventBus ?? new EventBus();
  const checkpoint = opts?.checkpoint ?? new MemoryWeaverCheckpoint();
  const events$ = new Subject<StoredEvent>();
  const rebuilds$ = new Subject<EventMap['weave:rebuild']>();

  const weaver = new Weaver(
    graph,
    events$.asObservable(),
    rebuilds$.asObservable(),
    asBusRequestPrimitive(eventBus),
    checkpoint,
    opts?.timing ?? TIMING_FAST,
    noopLogger,
  );
  await weaver.initialize();

  return {
    weaver,
    graph,
    eventBus,
    checkpoint,
    push: (e) => events$.next(e),
    pushRebuild: (cmd) => rebuilds$.next(cmd),
    dispose: async () => {
      await weaver.stop();
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until every resource's applied mark reaches its target sequence. */
export async function awaitMarks(
  weaver: Weaver,
  targets: Map<string, number>,
  maxMs = 3_000,
): Promise<boolean> {
  const t0 = Date.now();
  const reached = () =>
    [...targets].every(([rid, seq]) => (weaver.appliedUpTo(rid) ?? -1) >= seq);
  while (Date.now() - t0 < maxMs) {
    if (reached()) return true;
    await sleep(2);
  }
  return reached();
}

/** Per-resource max sequence in a history — the parity targets. */
export function maxSeqs(history: StoredEvent[]): Map<string, number> {
  const targets = new Map<string, number>();
  for (const e of history) {
    if (!e.resourceId) continue;
    const rid = String(e.resourceId);
    const seq = e.metadata.sequenceNumber;
    if ((targets.get(rid) ?? -1) < seq) targets.set(rid, seq);
  }
  return targets;
}
