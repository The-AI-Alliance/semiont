/**
 * Browser Actor
 *
 * Filesystem-shaped reads and KB graph reads for the Knowledge System.
 * Merges live filesystem state with KB metadata for tracked resources.
 *
 * Handles:
 * - browse:resource-requested — single resource metadata (materialized from events)
 * - browse:resources-requested — list resources
 * - browse:annotations-requested — all annotations for a resource
 * - browse:annotation-requested — single annotation with resolved resource
 * - browse:events-requested — resource event history
 * - browse:annotation-history-requested — annotation event history
 * - browse:entity-types-requested — list entity types from the project projection
 * - browse:tag-schemas-requested — list tag schemas from the project projection
 * - browse:agents-requested — the collaborator directory: the KB's declared software
 *   agents, derived from the workers + actors inference config
 * - browse:kb-requested — the KB's description of itself: the committed name and
 *   domain, and the working tree's branch
 * - browse:directory-requested — list a project directory, merging fs + ViewStorage
 */

import { promises as fs, type Dirent } from 'fs';
import * as path from 'path';
import { Subscription, from, EMPTY } from 'rxjs';
import { mergeMap, catchError } from 'rxjs/operators';
import type { SemiontProject } from '@semiont/core/node';
import type { AttributedEvent, EventMap, Logger, StoredEvent, components } from '@semiont/core';
import { EventBus, didToAgent, errField, getAnnotationIdFromEvent } from '@semiont/core';
import { withActorSpan } from '@semiont/observability';
import { getBodySource, getStorageUri } from '@semiont/core';
import { EventQuery } from '@semiont/event-sourcing';
import type { ViewStorage } from '@semiont/event-sourcing';
import { stagingFor, type WorkingTreeStore, type AnchoredTextStore } from '@semiont/content';
import type { EventStoreReads } from './record-slices';
import type { SmeltProgress } from '../smelt-progress';
import { readAnchoredText } from './read-anchored-text';
import { readEntityTypesProjection } from './views/entity-types-reader';
import { personNamer } from '../views/people-reader';
import { readTagSchemasProjection } from './views/tag-schemas-reader';
import { AnnotationContext } from '../annotation-context';
import { ResourceContext } from '../resource-context';
import { assembleResourceGraph } from './resource-graph';
import { deriveAgentRoster, type Roster } from './agent-roster';

type DirectoryEntry = components['schemas']['DirectoryEntry'];
type FileEntry      = components['schemas']['FileEntry'];
type DirEntry       = components['schemas']['DirEntry'];

/**
 * Browser's measured surface of the record — reads only, every member a
 * derived slice of its owning type. What is absent is the point: no
 * appendEvent, no content bytes beyond `retrieve`, no projectionsDir, no
 * weaveProgress.
 */
export interface BrowserReads {
  views: Pick<ViewStorage, 'get' | 'getAll' | 'exists'>;
  eventStore: EventStoreReads;
  content: Pick<WorkingTreeStore, 'retrieve'>;
  anchoredText: Pick<AnchoredTextStore, 'read'>;
  smeltProgress: Pick<SmeltProgress, 'whenSettled'>;
}

export class Browser {
  private subscriptions: Subscription[] = [];
  private readonly logger: Logger;

  constructor(
    private kb: BrowserReads,
    private eventBus: EventBus,
    private project: SemiontProject,
    /** Who serves each role — provider and model, no credential. The
     *  directory's limits come from the services that hold the keys. */
    private roster: Roster,
    logger: Logger,
  ) {
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('Browser actor initialized');

    const errorHandler = (err: unknown) =>
      this.logger.error('Browser pipeline error', { error: err });

    // `frames`: a responder echoes the key it was handed, and the payload
    // carries none — the correlationId rides the frame's envelope.
    const pipe = <K extends keyof EventMap>(
      name: K,
      handler: (event: EventMap[K], correlationId: string | undefined) => Promise<void>,
    ) => this.eventBus.frames(name).pipe(
      mergeMap((frame) =>
        from(
          withActorSpan('browser', name as string, () =>
            handler(frame.payload, frame.correlationId),
          ),
        ).pipe(
          // Isolate per-event failures: a single handler throw must NOT tear down the
          // channel subscription for every future request. Handlers emit their
          // own *-failed reply; this is the structural backstop for any throw that escapes a
          // handler's try/catch — the channel survives, the offending request is logged.
          // (A per-channel *-failed can't be emitted from this generic helper without the
          // request→failure mapping, which is `BUS_OPERATIONS`.)
          catchError((error) => {
            this.logger.error(`browse handler threw on ${name as string}`, { error: errField(error) });
            return EMPTY;
          }),
        ),
      ),
    );

    this.subscriptions.push(
      pipe('browse:resource-requested',          (e, cid) => this.handleBrowseResource(e, cid)).subscribe({ error: errorHandler }),
      pipe('browse:anchored-text-requested',     (e, cid) => this.handleAnchoredText(e, cid)).subscribe({ error: errorHandler }),
      pipe('browse:resources-requested',         (e, cid) => this.handleBrowseResources(e, cid)).subscribe({ error: errorHandler }),
      pipe('browse:annotations-requested',       (e, cid) => this.handleBrowseAnnotations(e, cid)).subscribe({ error: errorHandler }),
      pipe('browse:annotation-requested',        (e, cid) => this.handleBrowseAnnotation(e, cid)).subscribe({ error: errorHandler }),
      pipe('browse:events-requested',            (e, cid) => this.handleBrowseEvents(e, cid)).subscribe({ error: errorHandler }),
      pipe('browse:annotation-history-requested',(e, cid) => this.handleBrowseAnnotationHistory(e, cid)).subscribe({ error: errorHandler }),
      pipe('browse:entity-types-requested',      (e, cid) => this.handleEntityTypes(e, cid)).subscribe({ error: errorHandler }),
      pipe('browse:tag-schemas-requested',       (e, cid) => this.handleTagSchemas(e, cid)).subscribe({ error: errorHandler }),
      pipe('browse:agents-requested',            (e, cid) => this.handleBrowseAgents(e, cid)).subscribe({ error: errorHandler }),
      pipe('browse:kb-requested',                (e, cid) => this.handleBrowseKb(e, cid)).subscribe({ error: errorHandler }),
      pipe('browse:directory-requested',         (e, cid) => this.handleBrowseDirectory(e, cid)).subscribe({ error: errorHandler }),
    );
  }

  // ========================================================================
  // KB read handlers
  // ========================================================================

  /**
   * Serve a resource's derived coordinate map, whole-resource, over the bus.
   *
   * Read-your-writes on the same barrier `llm-context` uses for vectors: a
   * caller may arrive before the Smelter has finished the resource it just
   * uploaded, so a miss waits for that content generation to settle rather than
   * reporting "no map" for a document that is merely still being read.
   *
   * **This path never invokes the engine.** The Smelter is the sole producer.
   * A miss that survives the barrier answers a named absence (`not-yet` or
   * `no-map`), and the caller degrades — for a PDF annotation that means
   * geometry with no quoted text. OCR in a request path is precisely what this
   * design exists to avoid.
   */
  private async handleAnchoredText(event: EventMap['browse:anchored-text-requested'], correlationId: string | undefined): Promise<void> {
    try {
      this.eventBus.emit('browse:anchored-text-result', { response: await readAnchoredText(this.kb, event.resourceId), }, { correlationId });
    } catch (error) {
      this.logger.error('Browse anchored text failed', { resourceId: event.resourceId, error: errField(error) });
      this.eventBus.emit('browse:anchored-text-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  /**
   * Fill in the names of the people a reply mentions.
   *
   * The Browser owns the system projections, so it is where a DID becomes a
   * name — once, on the way out, rather than in each client. Artifacts carry
   * the DID and nothing else, which is what lets a rename correct every
   * artifact its subject ever wrote; this is the other half of that bargain.
   *
   * One projection read per reply, not per Agent.
   */
  private async named<T>(response: T): Promise<T> {
    return (await this.namer())(response);
  }

  /** The resolver `named` applies, over one read of the people projection. */
  private namer(): Promise<<T>(value: T) => T> {
    return personNamer(this.project, this.logger);
  }

  /**
   * Stored events as a history reply carries them: each with the agent its
   * `userId` identifies, a Person's name filled in. Only the agent is named.
   * The event beside it is the log's, payload and all: the Weaver rebuilds the
   * graph from these replies, and a name resolved into a payload here would be
   * a name written into the graph.
   */
  private async attributed(events: StoredEvent[]): Promise<AttributedEvent[]> {
    const name = await this.namer();
    return events.map((event) => ({ ...event, agent: name(didToAgent(event.userId)) }));
  }

  private async handleBrowseResource(event: EventMap['browse:resource-requested'], correlationId: string | undefined): Promise<void> {
    try {
      const response = await assembleResourceGraph(this.kb, event.resourceId);

      if (!response) {
        this.eventBus.emit('browse:resource-failed', { code: 'not-found',
          message: 'Resource not found', }, { correlationId });
        return;
      }

      this.eventBus.emit('browse:resource-result', { response: await this.named(response), }, { correlationId });
    } catch (error) {
      // No `code` here, deliberately: a thrown assembly is not evidence of
      // absence, and the SDK deletes a restored tab on 'not-found'.
      this.logger.error('Browse resource failed', { resourceId: event.resourceId, error: errField(error) });
      this.eventBus.emit('browse:resource-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleBrowseResources(event: EventMap['browse:resources-requested'], correlationId: string | undefined): Promise<void> {
    try {
      const offset = event.offset ?? 0;
      const limit = event.limit ?? 50;

      const result = await ResourceContext.listResources(
        { archived: event.archived, entityType: event.entityType, offset, limit },
        this.kb,
      );

      this.eventBus.emit('browse:resources-result', {
        response: await this.named({ resources: result.resources, total: result.total, offset, limit }),
      }, { correlationId });
    } catch (error) {
      this.logger.error('Browse resources failed', { error: errField(error) });
      this.eventBus.emit('browse:resources-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleBrowseAnnotations(event: EventMap['browse:annotations-requested'], correlationId: string | undefined): Promise<void> {
    try {
      const annotations = await AnnotationContext.getAllAnnotations(event.resourceId, this.kb);

      this.eventBus.emit('browse:annotations-result', {
        response: await this.named({
          annotations,
          total: annotations.length,
        }),
      }, { correlationId });
    } catch (error) {
      this.logger.error('Browse annotations failed', { resourceId: event.resourceId, error: errField(error) });
      this.eventBus.emit('browse:annotations-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleBrowseAnnotation(event: EventMap['browse:annotation-requested'], correlationId: string | undefined): Promise<void> {
    try {
      const annotation = await AnnotationContext.getAnnotation(event.annotationId, event.resourceId, this.kb);

      if (!annotation) {
        this.eventBus.emit('browse:annotation-failed', { message: 'Annotation not found', }, { correlationId });
        return;
      }

      const resource = await ResourceContext.getResourceMetadata(event.resourceId, this.kb);

      // Resolve linked resource if annotation body contains a link
      let resolvedResource = null;
      const bodySource = getBodySource(annotation.body);
      if (bodySource) {
        resolvedResource = await ResourceContext.getResourceMetadata(bodySource, this.kb);
      }

      this.eventBus.emit('browse:annotation-result', {
        response: await this.named({
          annotation,
          resource,
          resolvedResource,
        }),
      }, { correlationId });
    } catch (error) {
      this.logger.error('Browse annotation failed', { resourceId: event.resourceId, annotationId: event.annotationId, error: errField(error) });
      this.eventBus.emit('browse:annotation-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleBrowseEvents(event: EventMap['browse:events-requested'], correlationId: string | undefined): Promise<void> {
    try {
      const eventQuery = new EventQuery(this.kb.eventStore.log.storage);
      const filters: any = {
        resourceId: event.resourceId,
      };

      if (event.type) {
        filters.eventTypes = [event.type];
      }
      if (event.userId) {
        filters.userId = event.userId;
      }
      if (event.limit) {
        filters.limit = event.limit;
      }

      const storedEvents = await eventQuery.queryEvents(filters);

      this.eventBus.emit('browse:events-result', {
        response: {
          events: await this.attributed(storedEvents),
          total: storedEvents.length,
          resourceId: event.resourceId,
        },
      }, { correlationId });
    } catch (error) {
      this.logger.error('Browse events failed', { resourceId: event.resourceId, error: errField(error) });
      this.eventBus.emit('browse:events-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleBrowseAnnotationHistory(event: EventMap['browse:annotation-history-requested'], correlationId: string | undefined): Promise<void> {
    try {
      // Verify annotation exists
      const annotation = await AnnotationContext.getAnnotation(event.annotationId, event.resourceId, this.kb);
      if (!annotation) {
        this.eventBus.emit('browse:annotation-history-failed', { message: 'Annotation not found', }, { correlationId });
        return;
      }

      const eventQuery = new EventQuery(this.kb.eventStore.log.storage);
      const allEvents = await eventQuery.queryEvents({ resourceId: event.resourceId });

      const annotationEvents = allEvents.filter((stored) => getAnnotationIdFromEvent(stored) === event.annotationId);

      // Sort by sequence number
      annotationEvents.sort((a, b) => a.metadata.sequenceNumber - b.metadata.sequenceNumber);

      this.eventBus.emit('browse:annotation-history-result', {
        response: {
          events: await this.attributed(annotationEvents),
          total: annotationEvents.length,
          annotationId: event.annotationId,
          resourceId: event.resourceId,
        },
      }, { correlationId });
    } catch (error) {
      this.logger.error('Browse annotation history failed', { resourceId: event.resourceId, annotationId: event.annotationId, error: errField(error) });
      this.eventBus.emit('browse:annotation-history-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleEntityTypes(_event: EventMap['browse:entity-types-requested'], correlationId: string | undefined): Promise<void> {
    try {
      const entityTypes = await readEntityTypesProjection(this.project);
      this.eventBus.emit('browse:entity-types-result', {
        response: { entityTypes },
      }, { correlationId });
    } catch (error) {
      this.logger.error('Entity types read failed', { error: errField(error) });
      this.eventBus.emit('browse:entity-types-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleTagSchemas(_event: EventMap['browse:tag-schemas-requested'], correlationId: string | undefined): Promise<void> {
    try {
      const tagSchemas = await readTagSchemasProjection(this.project);
      this.eventBus.emit('browse:tag-schemas-result', {
        response: { tagSchemas },
      }, { correlationId });
    } catch (error) {
      this.logger.error('Tag schemas read failed', { error: errField(error) });
      this.eventBus.emit('browse:tag-schemas-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleBrowseAgents(_event: EventMap['browse:agents-requested'], correlationId: string | undefined): Promise<void> {
    try {
      // Derived per request from the config sections that route work — the
      // declared roster, cheap enough that no caching layer is warranted. It
      // carries no limits: the worker and the librarian, which hold the
      // inference credentials, report those (job:/gather:/match:limits).
      const agents = deriveAgentRoster(this.roster, this.project.siteDomain());
      this.eventBus.emit('browse:agents-result', {
        response: { agents },
      }, { correlationId });
    } catch (error) {
      this.logger.error('Agent roster derivation failed', { error: errField(error) });
      this.eventBus.emit('browse:agents-failed', { message: error instanceof Error ? error.message : String(error), }, { correlationId });
    }
  }

  private async handleBrowseKb(_event: EventMap['browse:kb-requested'], correlationId: string | undefined): Promise<void> {
    try {
      // Read at every ask, never kept: a `git checkout` in the tree restarts
      // nothing and emits nothing, so a kept answer would name a branch the
      // tree has left.
      const domain = this.project.siteDomain();
      if (!domain) {
        throw new Error('The committed .semiont/config declares no [site] domain');
      }
      const gitBranch = await stagingFor(this.project).currentBranch();
      this.eventBus.emit('browse:kb-result', {
        response: { name: this.project.name, domain, ...(gitBranch ? { gitBranch } : {}) },
      }, { correlationId });
    } catch (error) {
      this.logger.error('KB description read failed', { error: errField(error) });
      this.eventBus.emit('browse:kb-failed', { message: error instanceof Error ? error.message : String(error) }, { correlationId });
    }
  }

  // ========================================================================
  // Filesystem read handler
  // ========================================================================

  private async handleBrowseDirectory(
    event: EventMap['browse:directory-requested'], correlationId: string | undefined): Promise<void> {
    const { path: reqPath, sort = 'name' } = event;

    // Resolve and validate path
    const projectRoot = this.project.root;
    const resolved = path.resolve(projectRoot, reqPath);

    if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
      this.eventBus.emit('browse:directory-failed', { path: reqPath,
        message: 'path escapes project root', }, { correlationId });
      return;
    }

    let dirents: Dirent<string>[];
    try {
      dirents = await fs.readdir(resolved, { withFileTypes: true, encoding: 'utf8' });
    } catch (err: any) {
      const msg = err.code === 'ENOENT' ? 'path not found' : String(err);
      this.eventBus.emit('browse:directory-failed', { path: reqPath,
        message: msg, }, { correlationId });
      return;
    }

    // Exclude .semiont — internal infrastructure
    const visible = dirents.filter((d) => d.name !== '.semiont' && !d.name.startsWith('.'));

    // Build a map of storageUri → ResourceView for all tracked resources
    // whose storageUri starts with the resolved directory prefix.
    const allViews = await this.kb.views.getAll();
    const prefix = `file://${resolved}`;
    const viewsByUri = new Map(
      allViews
        .filter((v) => {
          const uri = getStorageUri(v.resource);
          return uri?.startsWith(prefix + '/') || uri?.startsWith(prefix + path.sep);
        })
        .map((v) => [getStorageUri(v.resource)!, v]),
    );

    // Build entries
    const entries: DirectoryEntry[] = [];

    for (const dirent of visible) {
      const entryPath = path.join(resolved, dirent.name);
      const relPath   = path.relative(projectRoot, entryPath);

      if (dirent.isDirectory()) {
        let mtime = new Date(0).toISOString();
        try {
          const stat = await fs.stat(entryPath);
          mtime = stat.mtime.toISOString();
        } catch { /* skip — entry may have disappeared */ }

        const entry: DirEntry = { type: 'dir', name: dirent.name, path: relPath, mtime };
        entries.push(entry);
      } else if (dirent.isFile()) {
        let size = 0;
        let mtime = new Date(0).toISOString();
        try {
          const stat = await fs.stat(entryPath);
          size  = stat.size;
          mtime = stat.mtime.toISOString();
        } catch { /* skip */ }

        const storageUri = `file://${entryPath}`;
        const view = viewsByUri.get(storageUri);

        let entry: FileEntry;
        if (view) {
          const annotations = view.annotations.annotations ?? [];
          entry = {
            type:            'file',
            name:            dirent.name,
            path:            relPath,
            size,
            mtime,
            tracked:         true,
            resourceId:      view.resource['@id'],
            entityTypes:     view.resource.entityTypes ?? [],
            annotationCount: annotations.length,
            creator:         (() => { const a = view.resource.wasAttributedTo; return Array.isArray(a) ? a[0]?.['@id'] : a?.['@id']; })(),
          };
        } else {
          entry = { type: 'file', name: dirent.name, path: relPath, size, mtime, tracked: false };
        }
        entries.push(entry);
      }
    }

    // Sort
    entries.sort((a, b) => {
      if (sort === 'mtime') {
        return (b.mtime ?? '').localeCompare(a.mtime ?? '');
      }
      if (sort === 'annotationCount') {
        const ac = (e: DirectoryEntry) => e.type === 'file' ? (e.annotationCount ?? 0) : 0;
        return ac(b) - ac(a);
      }
      // default: name
      return a.name.localeCompare(b.name);
    });

    this.eventBus.emit('browse:directory-result', {
      response: await this.named({ path: reqPath, entries }),
    }, { correlationId });
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    this.logger.info('Browser actor stopped');
  }
}
