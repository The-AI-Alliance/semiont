/**
 * Append-seam axioms — the ordering every downstream reader rests on.
 *
 * `EventStore.appendEvent` materializes views (its step 2) BEFORE it
 * publishes (its step 4), so any subscriber holding event N can read the
 * view and see N's effect. Everything downstream leans on that: the
 * Browser answers `browse:annotations-requested` from `kb.views.get` with
 * no barrier of any kind, and the SDK treats an event-triggered refetch as
 * authoritative for the event that triggered it.
 *
 * Until now that guarantee lived only in a class comment (`view-manager.ts`:
 * "it must block the caller until the view is written, so SSE subscribers
 * that see the subsequently-published event get the up-to-date view").
 * **An unenforced invariant is indistinguishable from a false one.** The
 * sibling invariant in the SDK's `cache-persister.ts` header — the persisted
 * bookmark "may therefore LAG the caches … but can never lead them" — is
 * asserted with exactly the same confidence in exactly the same register,
 * and is FALSE as implemented; that is the measured bug in
 * `.plans/bugs/pdf-annotations-vanish-after-reload-stale-persisted-cache.md`.
 * Prose cannot tell the two apart. These properties make this one executable.
 *
 * | Id | Axiom |
 * |----|-------|
 * | **V1** | **Materialize-before-publish.** At the instant an appended event is delivered on a bus channel, the view for its resource already reflects it — `lastSequence >= sequenceNumber`, and for `mark:added` the annotation is already in `view.annotations`. |
 * | **V2** | **Post-append read-your-writes.** Once `appendEvent` resolves, a fresh read through `ViewStorage` — the interface the Browser's annotations path uses — reflects the event. |
 *
 * **Teeth before trust** (LIVENESS-AXIOMS D3): the properties run first
 * against `PublishFirstEventStore`, a reconstructed double doing the
 * plausible latency refactor (publish early, let the view catch up), and
 * must FAIL. A property that has never been seen to fail is not evidence.
 *
 * Observation is synchronous by construction: the view store here is an
 * in-memory `ViewStorage` with a `peek()`, so a subscriber samples the view
 * at the exact instant of publish. An async read would race the very write
 * it is trying to catch, and could mask a violation instead of reporting it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { EventStore } from '../event-store';
import { EventLog } from '../event-log';
import { ViewManager } from '../view-manager';
import { SemiontProject } from '@semiont/core/node';
import {
  EventBus,
  resourceId,
  userId,
  type EventInput,
  type StoredEvent,
  type ResourceId,
} from '@semiont/core';
import type { ViewStorage, ResourceView } from '../storage/view-storage';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

// ── In-memory view storage with a synchronous observation point ──────────

class MemoryViewStorage implements ViewStorage {
  private views = new Map<string, ResourceView>();

  // Clone on the way in AND out: the materializer loads a view, mutates it,
  // then saves. Handing out (or holding) a live reference would let those
  // pre-save mutations show up in `peek()` — masking the exact ordering
  // violation these properties exist to catch.
  async save(rid: ResourceId, view: ResourceView): Promise<void> {
    this.views.set(String(rid), structuredClone(view));
  }
  async get(rid: ResourceId): Promise<ResourceView | null> {
    const view = this.views.get(String(rid));
    return view ? structuredClone(view) : null;
  }
  async delete(rid: ResourceId): Promise<void> {
    this.views.delete(String(rid));
  }
  async exists(rid: ResourceId): Promise<boolean> {
    return this.views.has(String(rid));
  }
  async getAll(): Promise<ResourceView[]> {
    return [...this.views.values()].map((v) => structuredClone(v));
  }

  /** Sample the view synchronously — no IO between publish and observation. */
  peek(rid: ResourceId): ResourceView | null {
    return this.views.get(String(rid)) ?? null;
  }
}

// ── The teeth: a store that publishes before the view catches up ─────────

/**
 * The refactor V1 forbids, written out: persist, announce, and let the view
 * materialize afterwards so `appendEvent` returns sooner. Every unit test in
 * this package still passes against it — the events are all logged, the views
 * all end up correct. Only the seam is broken, and only V1 can see it.
 */
class PublishFirstEventStore {
  readonly log: EventLog;
  readonly views: ViewManager;

  constructor(
    project: SemiontProject,
    stateDir: string,
    viewStorage: ViewStorage,
    private readonly bus: EventBus,
  ) {
    this.log = new EventLog({ project });
    this.views = new ViewManager(viewStorage, { basePath: stateDir });
  }

  async appendEvent(event: EventInput): Promise<StoredEvent> {
    const rid = event.resourceId as ResourceId;
    const storedEvent = await this.log.append(event, rid);
    this.bus.getDomainEvent(storedEvent.type).next(storedEvent);
    this.bus.scope(String(rid)).getDomainEvent(storedEvent.type).next(storedEvent);
    await this.views.materializeResource(rid, storedEvent, () => this.log.getEvents(rid));
    return storedEvent;
  }
}

// ── Event factories ─────────────────────────────────────────────────────

function createdEvent(rid: ResourceId): EventInput {
  return {
    type: 'yield:created',
    userId: userId('user1'),
    resourceId: rid,
    version: 1,
    payload: { name: 'Test Resource', format: 'text/plain', contentChecksum: 'cs-init' },
  } as EventInput;
}

function markAddedEvent(rid: ResourceId, index: number): EventInput {
  return {
    type: 'mark:added',
    userId: userId('user1'),
    resourceId: rid,
    version: 1,
    payload: {
      annotation: {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: `ann-${String(rid)}-${index}`,
        motivation: 'highlighting',
        target: {
          source: String(rid),
          selector: { type: 'TextQuoteSelector', exact: `chunk ${index}` },
        },
      },
    },
  } as EventInput;
}

// ── The property, shared by the teeth run and the real run ──────────────

interface Appender {
  appendEvent(event: EventInput): Promise<StoredEvent>;
}

/**
 * `plan` is a list of resource indices; each entry appends the next event
 * for that resource (first `yield:created`, then `mark:added`). Repeats and
 * interleavings across resources both fall out of the generator.
 */
async function collectViolations(
  makeAppender: (storage: MemoryViewStorage, bus: EventBus) => Appender,
  plan: number[],
  runId: number,
): Promise<{ violations: string[]; observed: number }> {
  const storage = new MemoryViewStorage();
  const bus = new EventBus();
  const appender = makeAppender(storage, bus);
  const violations: string[] = [];
  let observed = 0;

  // Sample the view at the instant of publish — this is V1's observation.
  const observe = (event: StoredEvent): void => {
    observed++;
    const rid = event.resourceId as ResourceId;
    const seq = event.metadata.sequenceNumber;
    const view = storage.peek(rid);
    if (!view) {
      violations.push(`V1: ${event.type} seq=${seq} published with no view for ${String(rid)} at all`);
      return;
    }
    if ((view.lastSequence ?? -1) < seq) {
      violations.push(
        `V1: ${event.type} seq=${seq} published while the view for ${String(rid)} was still at lastSequence=${view.lastSequence}`,
      );
    }
    if (event.type === 'mark:added') {
      const annotationId = String(
        (event.payload as { annotation?: { id?: string } }).annotation?.id,
      );
      const present = view.annotations.annotations.some((a) => String(a.id) === annotationId);
      if (!present) {
        violations.push(
          `V1: mark:added seq=${seq} published while annotation ${annotationId} was absent from the view`,
        );
      }
    }
  };

  const subscriptions = [
    bus.getDomainEvent('yield:created').subscribe(observe),
    bus.getDomainEvent('mark:added').subscribe(observe),
  ];

  try {
    // Fresh resource ids per run: sequence numbers are per-resource, so this
    // keeps runs independent without a temp dir per run.
    const nextIndex = new Map<number, number>();
    for (const slot of plan) {
      const rid = resourceId(`res-${runId}-${slot}`);
      const index = nextIndex.get(slot) ?? 0;
      nextIndex.set(slot, index + 1);

      const event = index === 0 ? createdEvent(rid) : markAddedEvent(rid, index);
      const stored = await appender.appendEvent(event);

      // V2: the Browser's read path, taken after the append resolves.
      const view = await storage.get(rid);
      const seq = stored.metadata.sequenceNumber;
      if (!view || (view.lastSequence ?? -1) < seq) {
        violations.push(
          `V2: after appendEvent resolved for ${stored.type} seq=${seq}, a fresh read of ${String(rid)} was at lastSequence=${view?.lastSequence ?? 'no view'}`,
        );
      }
    }
  } finally {
    subscriptions.forEach((s) => s.unsubscribe());
    bus.destroy();
  }

  return { violations, observed };
}

const arbPlan = fc.array(fc.nat({ max: 2 }), { minLength: 1, maxLength: 10 });

describe('Append-seam axioms (V1, V2)', () => {
  let testDir: string;
  let project: SemiontProject;
  let runCounter = 0;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-append-seam-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    project = new SemiontProject(testDir, { anchoredTextDir: `${testDir}/anchored-text` });
  });

  afterAll(async () => {
    await project.destroy();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('teeth — the properties must catch a publish-first store', () => {
    it('V1/V2 fail against PublishFirstEventStore', async () => {
      const { violations, observed } = await collectViolations(
        (storage, bus) => new PublishFirstEventStore(project, testDir, storage, bus),
        [0, 0, 0],
        ++runCounter,
      );

      expect(observed).toBe(3);
      expect(violations.some((v) => v.startsWith('V1:'))).toBe(true);
      // V2 survives the reorder — `appendEvent` still awaits materialization
      // before it resolves. That asymmetry is the point: V2 alone would have
      // called this store correct.
      expect(violations.some((v) => v.startsWith('V2:'))).toBe(false);
    });
  });

  describe('the real EventStore', () => {
    it('V1: an event is never published before its view reflects it', async () => {
      await fc.assert(
        fc.asyncProperty(arbPlan, async (plan) => {
          const { violations, observed } = await collectViolations(
            (storage, bus) => new EventStore(project, testDir, storage, bus),
            plan,
            ++runCounter,
          );
          // Non-vacuity: every appended event must have been observed at its
          // publish instant. Without this, a green run is also what a silent
          // subscription would produce.
          expect(observed).toBe(plan.length);
          expect(violations).toEqual([]);
        }),
        { numRuns: 25 },
      );
    });
  });
});
