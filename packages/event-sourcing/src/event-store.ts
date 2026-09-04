/**
 * EventStore - Orchestration Layer
 *
 * Coordinates event sourcing operations:
 * - EventLog: Event persistence (append, retrieve, query)
 * - ViewManager: View materialization (resource and system)
 * - Core EventBus: Publishes StoredEvent to typed channels after persistence
 *
 * appendEvent() is the single write path:
 *   1. Persist to EventLog
 *   2. Materialize views
 *   3. Enrich (optional callback — attach post-materialization data)
 *   4. Publish StoredEvent to global and resource-scoped typed channels
 */

import type {
  EventInput,
  StoredEvent,
  ResourceId,
  Logger,
} from '@semiont/core';
import { recordAppendStage } from '@semiont/observability';
import { EventBus as CoreEventBus } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import type { ViewStorage } from './storage/view-storage';
import { EventLog } from './event-log';
import { ViewManager, type ViewManagerConfig } from './view-manager';

export type EnrichEvent = (event: StoredEvent, resourceId: ResourceId) => Promise<StoredEvent>;

export class EventStore {
  readonly log: EventLog;
  readonly views: ViewManager;
  readonly viewStorage: ViewStorage;
  readonly coreEventBus: CoreEventBus;
  private enrichEvent: EnrichEvent | null = null;

  constructor(
    project: SemiontProject,
    stateDir: string,
    viewStorage: ViewStorage,
    coreEventBus: CoreEventBus,
    logger?: Logger
  ) {
    this.viewStorage = viewStorage;
    this.coreEventBus = coreEventBus;

    this.log = new EventLog({ project }, logger?.child({ component: 'EventLog' }));

    const viewConfig: ViewManagerConfig = {
      basePath: stateDir,
    };
    this.views = new ViewManager(viewStorage, viewConfig, logger?.child({ component: 'ViewManager' }));
  }

  setEnrichEvent(fn: EnrichEvent): void {
    this.enrichEvent = fn;
  }

  /**
   * Append an event to the store
   * Coordinates: persistence → view → enrich → notification
   *
   * @param options.correlationId - Optional id propagated from a command.
   */
  async appendEvent(
    event: EventInput,
    options?: { correlationId?: string },
  ): Promise<StoredEvent> {
    const resourceId: ResourceId | '__system__' = event.resourceId || '__system__';

    // Each stage is timed separately (ARCHIVIST-STAYS-UP P7). The useful
    // question is never "was the append slow" but WHICH stage: `persist`
    // includes a SYNCHRONOUS git add that blocks the event loop, and
    // `materialize` does work proportional to the resource's annotation
    // count — so one degrades with concurrency and the other with history.
    const timed = async <T>(stage: 'persist' | 'materialize' | 'enrich' | 'publish', run: () => Promise<T> | T): Promise<T> => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        recordAppendStage(stage, performance.now() - started);
      }
    };

    // 1. Persist event to log
    const storedEvent = await timed('persist', () => this.log.append(event, resourceId as any, options));

    // 2. Update views
    await timed('materialize', async () => {
      if (resourceId === '__system__') {
        await this.views.materializeSystem(
          storedEvent.type,
          storedEvent.payload
        );
      } else {
        await this.views.materializeResource(
          resourceId as ResourceId,
          storedEvent,
          () => this.log.getEvents(resourceId as ResourceId)
        );
      }
    });

    // 3. Enrich (attach post-materialization data like annotations)
    let publishEvent = storedEvent;
    if (this.enrichEvent && resourceId !== '__system__') {
      publishEvent = await timed('enrich', () => this.enrichEvent!(storedEvent, resourceId as ResourceId));
    }

    // 4. Publish to Core EventBus typed channels
    await timed('publish', () => {
      this.coreEventBus.getDomainEvent(publishEvent.type).next(publishEvent);

      if (resourceId !== '__system__') {
        const scopedBus = this.coreEventBus.scope(resourceId as string);
        scopedBus.getDomainEvent(publishEvent.type).next(publishEvent);
      }
    });

    return storedEvent;
  }
}
