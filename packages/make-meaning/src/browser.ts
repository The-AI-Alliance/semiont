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
 * - browse:referenced-by-requested — find annotations in the KB graph that reference a resource
 * - browse:entity-types-requested — list entity types from the project projection
 * - browse:directory-requested — list a project directory, merging fs + ViewStorage
 */

import { promises as fs, type Dirent } from 'fs';
import * as path from 'path';
import { Subscription, from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import type { SemiontProject } from '@semiont/core/node';
import type { EventMap, Logger, components } from '@semiont/core';
import { EventBus, resourceId, annotationId, errField } from '@semiont/core';
import { getExactText, getTargetSource, getTargetSelector, getResourceEntityTypes, getBodySource } from '@semiont/api-client';
import { EventQuery } from '@semiont/event-sourcing';
import type { ViewStorage } from '@semiont/event-sourcing';
import { getEntityTypes } from '@semiont/ontology';
import type { KnowledgeBase } from './knowledge-base';
import { readEntityTypesProjection } from './views/entity-types-reader';
import { AnnotationContext } from './annotation-context';
import { ResourceContext } from './resource-context';

type DirectoryEntry = components['schemas']['DirectoryEntry'];
type FileEntry      = components['schemas']['FileEntry'];
type DirEntry       = components['schemas']['DirEntry'];
type Annotation     = components['schemas']['Annotation'];

export class Browser {
  private subscriptions: Subscription[] = [];
  private readonly logger: Logger;

  constructor(
    private views: ViewStorage,
    private kb: KnowledgeBase,
    private eventBus: EventBus,
    private project: SemiontProject,
    logger: Logger,
  ) {
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('Browser actor initialized');

    const errorHandler = (err: unknown) =>
      this.logger.error('Browser pipeline error', { error: err });

    const pipe = <K extends keyof EventMap>(
      name: K,
      handler: (event: EventMap[K]) => Promise<void>,
    ) => this.eventBus.get(name).pipe(mergeMap((event) => from(handler(event))));

    this.subscriptions.push(
      pipe('browse:resource-requested',          (e) => this.handleBrowseResource(e)).subscribe({ error: errorHandler }),
      pipe('browse:resources-requested',         (e) => this.handleBrowseResources(e)).subscribe({ error: errorHandler }),
      pipe('browse:annotations-requested',       (e) => this.handleBrowseAnnotations(e)).subscribe({ error: errorHandler }),
      pipe('browse:annotation-requested',        (e) => this.handleBrowseAnnotation(e)).subscribe({ error: errorHandler }),
      pipe('browse:events-requested',            (e) => this.handleBrowseEvents(e)).subscribe({ error: errorHandler }),
      pipe('browse:annotation-history-requested',(e) => this.handleBrowseAnnotationHistory(e)).subscribe({ error: errorHandler }),
      pipe('browse:referenced-by-requested',     (e) => this.handleReferencedBy(e)).subscribe({ error: errorHandler }),
      pipe('browse:entity-types-requested',      (e) => this.handleEntityTypes(e)).subscribe({ error: errorHandler }),
      pipe('browse:directory-requested',         (e) => this.handleBrowseDirectory(e)).subscribe({ error: errorHandler }),
    );
  }

  // ========================================================================
  // KB read handlers
  // ========================================================================

  private async handleBrowseResource(event: EventMap['browse:resource-requested']): Promise<void> {
    try {
      // Materialize from event store (matches get-uri.ts JSON-LD path)
      const eventQuery = new EventQuery(this.kb.eventStore.log.storage);
      const events = await eventQuery.getResourceEvents(resourceId(event.resourceId));
      const stored = await this.kb.eventStore.views.materializer.materialize(events, resourceId(event.resourceId));

      if (!stored) {
        this.eventBus.get('browse:resource-failed').next({
          correlationId: event.correlationId,
          message: 'Resource not found',
        });
        return;
      }

      const annotations = stored.annotations.annotations;
      const entityReferences = annotations.filter((a: Annotation) => {
        if (a.motivation !== 'linking') return false;
        return getEntityTypes({ body: a.body }).length > 0;
      });

      this.eventBus.get('browse:resource-result').next({
        correlationId: event.correlationId,
        response: {
          resource: stored.resource,
          annotations,
          entityReferences,
        },
      });
    } catch (error) {
      this.logger.error('Browse resource failed', { resourceId: event.resourceId, error: errField(error) });
      this.eventBus.get('browse:resource-failed').next({
        correlationId: event.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleBrowseResources(event: EventMap['browse:resources-requested']): Promise<void> {
    try {
      let filteredDocs = await ResourceContext.listResources({
        search: event.search,
        archived: event.archived,
      }, this.kb);

      // Filter by entity type
      if (event.entityType) {
        filteredDocs = filteredDocs.filter((doc) => getResourceEntityTypes(doc).includes(event.entityType!));
      }

      // Paginate
      const offset = event.offset ?? 0;
      const limit = event.limit ?? 50;
      const paginatedDocs = filteredDocs.slice(offset, offset + limit);

      // Add content previews for search results
      const formattedDocs = event.search
        ? await ResourceContext.addContentPreviews(paginatedDocs, this.kb)
        : paginatedDocs;

      this.eventBus.get('browse:resources-result').next({
        correlationId: event.correlationId,
        response: {
          resources: formattedDocs,
          total: filteredDocs.length,
          offset,
          limit,
        },
      });
    } catch (error) {
      this.logger.error('Browse resources failed', { error: errField(error) });
      this.eventBus.get('browse:resources-failed').next({
        correlationId: event.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleBrowseAnnotations(event: EventMap['browse:annotations-requested']): Promise<void> {
    try {
      const annotations = await AnnotationContext.getAllAnnotations(resourceId(event.resourceId), this.kb);

      this.eventBus.get('browse:annotations-result').next({
        correlationId: event.correlationId,
        response: {
          annotations,
          total: annotations.length,
        },
      });
    } catch (error) {
      this.logger.error('Browse annotations failed', { resourceId: event.resourceId, error: errField(error) });
      this.eventBus.get('browse:annotations-failed').next({
        correlationId: event.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleBrowseAnnotation(event: EventMap['browse:annotation-requested']): Promise<void> {
    try {
      const annotation = await AnnotationContext.getAnnotation(annotationId(event.annotationId), resourceId(event.resourceId), this.kb);

      if (!annotation) {
        this.eventBus.get('browse:annotation-failed').next({
          correlationId: event.correlationId,
          message: 'Annotation not found',
        });
        return;
      }

      const resource = await ResourceContext.getResourceMetadata(resourceId(event.resourceId), this.kb);

      // Resolve linked resource if annotation body contains a link
      let resolvedResource = null;
      const bodySource = getBodySource(annotation.body);
      if (bodySource) {
        resolvedResource = await ResourceContext.getResourceMetadata(resourceId(bodySource), this.kb);
      }

      this.eventBus.get('browse:annotation-result').next({
        correlationId: event.correlationId,
        response: {
          annotation,
          resource,
          resolvedResource,
        },
      });
    } catch (error) {
      this.logger.error('Browse annotation failed', { resourceId: event.resourceId, annotationId: event.annotationId, error: errField(error) });
      this.eventBus.get('browse:annotation-failed').next({
        correlationId: event.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleBrowseEvents(event: EventMap['browse:events-requested']): Promise<void> {
    try {
      const eventQuery = new EventQuery(this.kb.eventStore.log.storage);
      const filters: any = {
        resourceId: resourceId(event.resourceId),
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

      this.eventBus.get('browse:events-result').next({
        correlationId: event.correlationId,
        response: {
          events: storedEvents,
          total: storedEvents.length,
          resourceId: event.resourceId,
        },
      });
    } catch (error) {
      this.logger.error('Browse events failed', { resourceId: event.resourceId, error: errField(error) });
      this.eventBus.get('browse:events-failed').next({
        correlationId: event.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleBrowseAnnotationHistory(event: EventMap['browse:annotation-history-requested']): Promise<void> {
    try {
      // Verify annotation exists
      const annotation = await AnnotationContext.getAnnotation(annotationId(event.annotationId), resourceId(event.resourceId), this.kb);
      if (!annotation) {
        this.eventBus.get('browse:annotation-history-failed').next({
          correlationId: event.correlationId,
          message: 'Annotation not found',
        });
        return;
      }

      const eventQuery = new EventQuery(this.kb.eventStore.log.storage);
      const allEvents = await eventQuery.queryEvents({ resourceId: resourceId(event.resourceId) });

      // Filter events related to this annotation
      const annotationEvents = allEvents.filter((stored) => {
        const p = stored.payload as any;
        if (p?.highlightId === event.annotationId) return true;
        if (p?.referenceId === event.annotationId) return true;
        return false;
      });

      // Sort by sequence number
      annotationEvents.sort((a, b) => a.metadata.sequenceNumber - b.metadata.sequenceNumber);

      this.eventBus.get('browse:annotation-history-result').next({
        correlationId: event.correlationId,
        response: {
          events: annotationEvents,
          total: annotationEvents.length,
          annotationId: event.annotationId,
          resourceId: event.resourceId,
        },
      });
    } catch (error) {
      this.logger.error('Browse annotation history failed', { resourceId: event.resourceId, annotationId: event.annotationId, error: errField(error) });
      this.eventBus.get('browse:annotation-history-failed').next({
        correlationId: event.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleReferencedBy(
    event: EventMap['browse:referenced-by-requested'],
  ): Promise<void> {
    try {
      this.logger.debug('Looking for annotations referencing resource', {
        resourceId: event.resourceId,
        motivation: event.motivation || 'all',
      });

      const references = await this.kb.graph.getResourceReferencedBy(resourceId(event.resourceId), event.motivation);

      const sourceIds = [...new Set(references.map(ref => getTargetSource(ref.target)))];
      const resources = await Promise.all(sourceIds.map(id => this.kb.graph.getResource(resourceId(id))));

      for (let i = 0; i < sourceIds.length; i++) {
        if (resources[i] === null) {
          this.logger.warn('Referenced resource not found in graph', { resourceId: sourceIds[i] });
        }
      }
      const docMap = new Map(resources.filter(doc => doc !== null).map(doc => [doc['@id'], doc]));

      const referencedBy = references.map(ref => {
        const targetSource = getTargetSource(ref.target);
        const targetSelector = getTargetSelector(ref.target);
        const doc = docMap.get(targetSource);
        return {
          id: ref.id,
          resourceName: doc?.name || 'Untitled Resource',
          target: {
            source: targetSource,
            selector: {
              exact: targetSelector ? getExactText(targetSelector) : '',
            },
          },
        };
      });

      this.eventBus.get('browse:referenced-by-result').next({
        correlationId: event.correlationId,
        response: { referencedBy },
      });
    } catch (error) {
      this.logger.error('Referenced-by query failed', { resourceId: event.resourceId, error: errField(error) });
      this.eventBus.get('browse:referenced-by-failed').next({
        correlationId: event.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleEntityTypes(event: EventMap['browse:entity-types-requested']): Promise<void> {
    try {
      const entityTypes = await readEntityTypesProjection(this.project);
      this.eventBus.get('browse:entity-types-result').next({
        correlationId: event.correlationId,
        response: { entityTypes },
      });
    } catch (error) {
      this.logger.error('Entity types read failed', { error: errField(error) });
      this.eventBus.get('browse:entity-types-failed').next({
        correlationId: event.correlationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ========================================================================
  // Filesystem read handler
  // ========================================================================

  private async handleBrowseDirectory(
    event: EventMap['browse:directory-requested'],
  ): Promise<void> {
    const { correlationId, path: reqPath, sort = 'name' } = event;

    // Resolve and validate path
    const projectRoot = this.project.root;
    const resolved = path.resolve(projectRoot, reqPath);

    if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
      this.eventBus.get('browse:directory-failed').next({
        correlationId,
        path: reqPath,
        message: 'path escapes project root',
      });
      return;
    }

    let dirents: Dirent<string>[];
    try {
      dirents = await fs.readdir(resolved, { withFileTypes: true, encoding: 'utf8' });
    } catch (err: any) {
      const msg = err.code === 'ENOENT' ? 'path not found' : String(err);
      this.eventBus.get('browse:directory-failed').next({
        correlationId,
        path: reqPath,
        message: msg,
      });
      return;
    }

    // Exclude .semiont — internal infrastructure
    const visible = dirents.filter((d) => d.name !== '.semiont' && !d.name.startsWith('.'));

    // Build a map of storageUri → ResourceView for all tracked resources
    // whose storageUri starts with the resolved directory prefix.
    const allViews = await this.views.getAll();
    const prefix = `file://${resolved}`;
    const viewsByUri = new Map(
      allViews
        .filter((v) => v.resource.storageUri?.startsWith(prefix + '/') || v.resource.storageUri?.startsWith(prefix + path.sep))
        .map((v) => [v.resource.storageUri!, v]),
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

    this.eventBus.get('browse:directory-result').next({
      correlationId,
      response: { path: reqPath, entries },
    });
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    this.logger.info('Browser actor stopped');
  }
}
