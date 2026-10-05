/**
 * The Archivist, composed: the record, the three actors that hold it, and the
 * handlers that sit beside them, on one bus. What `archivist-main` adds is
 * the wire — the bus pumps and the HTTP surface.
 */

import { EventBus, type Logger } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import { createEventStore, type EventStore, type ViewStorage } from '@semiont/event-sourcing';
import { WorkingTreeStore, createAnchoredTextStore, stagingFor, type AnchoredTextStore } from '@semiont/content';
import { Stower } from './stower';
import { Browser } from './browser';
import { CloneTokenManager } from './clone-token-manager';
import { createSmeltProgress } from '../smelt-progress';
import type { RosterConfig } from '../config';
import { registerAnnotationAssemblyHandler } from './annotation-assembly';
import { registerAnnotationContextHandler } from './annotation-context-handler';
import { registerBindUpdateBodyHandler } from './bind-update-body';
import { workingTreeContentReads } from './record-slices';
import { anchoredTextOverBus } from '../anchored-text-ask';
import { asBusRequestPrimitive } from '../bus-request-local';
import { bootstrapEntityTypes } from './bootstrap-entity-types';
import { wireEnrichment } from './event-enrichment';

export interface Archivist {
  /** The bus the actors answer on. Nothing crosses a process boundary here. */
  bus: EventBus;
  eventStore: EventStore;
  views: ViewStorage;
  content: WorkingTreeStore;
  /** The knowledge base's `[site] domain`: the identity it acts under. */
  kbDomain: string;
  stop(): Promise<void>;
}

export async function composeArchivist(
  project: SemiontProject,
  /** Who serves each role — provider and model, no credential. */
  roster: RosterConfig,
  logger: Logger,
  options: { skipRebuild: boolean },
): Promise<Archivist> {
  // A config that says `[git] sync = true` over a tree git cannot stage into
  // is refused here, before anything is rebuilt or served. A knowledge base
  // that does not sync git runs no git, and this resolves at once.
  await stagingFor(project, { logger: logger.child({ component: 'staging' }) }).ready();
  const kbDomain = project.siteDomain();
  if (!kbDomain) {
    throw new Error("The knowledge base's committed .semiont/config declares no [site] domain: it is the identity this knowledge base acts under, and the audience it accepts tokens for");
  }
  const bus = new EventBus();

  const eventStore = createEventStore(project, bus, logger.child({ component: 'event-store' }));
  if (!options.skipRebuild) {
    // The Browser reads views, so they are populated before any request is
    // served. The Archivist is the ONE rebuild owner: no reader rebuilds.
    logger.info('Rebuilding materialized views from the event log');
    await eventStore.views.rebuildAll(eventStore.log);
  }
  const views = eventStore.viewStorage;
  // Annotation enrichment rides this process's append path: published
  // facts carry their annotation.
  wireEnrichment(eventStore, { views });
  const content = new WorkingTreeStore(project, logger.child({ component: 'working-tree-store' }));
  // Read-only from construction: this process shares the directory with
  // the store's single writer, the Smelter, so the narrowing — not mere
  // abstinence — is what keeps single-writer true. Widening this type
  // breaks that; it is not a refactor.
  const anchoredText: Pick<AnchoredTextStore, 'read'> = createAnchoredTextStore(project.anchoredTextDir, logger.child({ component: 'anchored-text-store' }));
  const smeltProgress = createSmeltProgress(bus);

  const stower = new Stower({ content, eventStore }, bus, project, logger.child({ component: 'stower' }));
  await stower.initialize();

  const browser = new Browser(
    { views, eventStore, content, anchoredText, smeltProgress },
    bus, project, roster, logger.child({ component: 'browser' }),
  );
  await browser.initialize();

  const cloneTokenManager = new CloneTokenManager({ views, content }, bus, logger.child({ component: 'clone-token-manager' }));
  await cloneTokenManager.initialize();

  // The fact-consumers follow the facts, so no fact crosses a process
  // boundary as an emit: annotation-assembly subscribes to the mark:added
  // this Stower publishes.
  registerAnnotationAssemblyHandler(bus, { views }, logger);

  // The bind re-emit only translates `bind:update-body` into
  // `mark:update-body` and matches the Stower's reply back.
  registerBindUpdateBodyHandler(bus, logger);

  // A views+content read, in the process that holds both. Derived text rides
  // the same bus read everywhere; here the Browser beside it answers.
  registerAnnotationContextHandler(
    bus,
    {
      views,
      content: workingTreeContentReads(views, content),
      anchoredText: anchoredTextOverBus(asBusRequestPrimitive(bus)),
    },
    logger,
  );

  // Vocabulary bootstrap emits frame:add-entity-type for missing defaults —
  // handled by the Stower above, with no cross-service boot race.
  await bootstrapEntityTypes(bus, eventStore, kbDomain, logger.child({ component: 'entity-types-bootstrap' }));

  return {
    bus, eventStore, views, content, kbDomain,
    stop: async () => {
      await Promise.all([stower.stop(), browser.stop(), cloneTokenManager.stop()]);
      smeltProgress.dispose();
      bus.destroy();
    },
  };
}
