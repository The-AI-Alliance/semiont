/**
 * Browser Actor
 *
 * Filesystem-shaped reads for the Knowledge System.
 * Merges live filesystem state with KB metadata for tracked resources.
 *
 * Handles:
 * - browse:directory-requested — list a project directory, merging fs + ViewStorage
 *
 * The Browser owns all filesystem I/O in the Knowledge System. This keeps the
 * Gatherer focused on semantic context assembly and free of fs dependencies.
 */

import { promises as fs, type Dirent } from 'fs';
import * as path from 'path';
import { Subscription, from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import type { SemiontProject } from '@semiont/core/node';
import type { EventMap, Logger, components } from '@semiont/core';
import { EventBus } from '@semiont/core';
import type { ViewStorage } from '@semiont/event-sourcing';

type DirectoryEntry = components['schemas']['DirectoryEntry'];
type FileEntry      = components['schemas']['FileEntry'];
type DirEntry       = components['schemas']['DirEntry'];

export class Browser {
  private subscriptions: Subscription[] = [];
  private readonly logger: Logger;

  constructor(
    private views: ViewStorage,
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

    const browseDirectory$ = this.eventBus.get('browse:directory-requested').pipe(
      mergeMap((event) => from(this.handleBrowseDirectory(event))),
    );

    this.subscriptions.push(
      browseDirectory$.subscribe({ error: errorHandler }),
    );
  }

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
        error: new Error('path escapes project root'),
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
        error: new Error(msg),
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
