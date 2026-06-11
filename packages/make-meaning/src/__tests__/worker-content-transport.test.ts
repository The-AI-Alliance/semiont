/**
 * WorkerContentTransport Tests
 *
 * Exercises the worker-side IContentTransport: descriptor resolution over
 * a fake bus (browse:resource-requested) + byte reads from a real
 * WorkingTreeStore rooted in a temp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { EventMap, components } from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
import { WorkingTreeStore } from '@semiont/content';
import type { BusRequestPrimitive } from '@semiont/sdk';
import { WorkerContentTransport } from '../worker-content-transport';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

function createFakeResourceBus(descriptors: Map<string, ResourceDescriptor>): BusRequestPrimitive {
  const results = new Subject<Record<string, unknown>>();
  const failures = new Subject<Record<string, unknown>>();
  return {
    async emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): Promise<void> {
      if (channel !== 'browse:resource-requested') return;
      const request = payload as Record<string, unknown>;
      const descriptor = descriptors.get(request.resourceId as string);
      queueMicrotask(() => {
        if (descriptor) {
          results.next({
            correlationId: request.correlationId,
            response: { resource: descriptor, annotations: [], entityReferences: [] },
          });
        } else {
          failures.next({ correlationId: request.correlationId, message: 'Resource not found' });
        }
      });
    },
    stream<K extends keyof EventMap>(channel: K): Observable<EventMap[K]> {
      const subject = channel === 'browse:resource-failed' ? failures : results;
      return subject as unknown as Observable<EventMap[K]>;
    },
  };
}

describe('WorkerContentTransport', () => {
  let projectRoot: string;
  let descriptors: Map<string, ResourceDescriptor>;
  let transport: WorkerContentTransport;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'worker-content-'));
    mkdirSync(join(projectRoot, 'docs'));
    writeFileSync(join(projectRoot, 'docs', 'overview.md'), '# Overview\n\nWorking-tree bytes.');

    descriptors = new Map();
    descriptors.set('res-overview', {
      '@context': 'https://schema.org',
      '@id': 'res-overview',
      name: 'overview',
      representations: [{ mediaType: 'text/markdown', storageUri: 'file://docs/overview.md' }],
    });
    descriptors.set('res-no-uri', {
      '@context': 'https://schema.org',
      '@id': 'res-no-uri',
      name: 'no-uri',
      representations: [{ mediaType: 'text/plain' }],
    });

    transport = new WorkerContentTransport(
      createFakeResourceBus(descriptors),
      new WorkingTreeStore(new SemiontProject(projectRoot)),
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('reads bytes from the working tree at the descriptor storageUri', async () => {
    const { data, contentType } = await transport.getBinary(makeResourceId('res-overview'));

    expect(contentType).toBe('text/markdown');
    expect(new TextDecoder().decode(data)).toBe('# Overview\n\nWorking-tree bytes.');
  });

  it('streams the same bytes via getBinaryStream', async () => {
    const { stream, contentType } = await transport.getBinaryStream(makeResourceId('res-overview'));

    expect(contentType).toBe('text/markdown');
    const text = await new Response(stream).text();
    expect(text).toBe('# Overview\n\nWorking-tree bytes.');
  });

  it('rejects when the descriptor has no storageUri', async () => {
    await expect(transport.getBinary(makeResourceId('res-no-uri'))).rejects.toThrow('no representation with a storageUri');
  });

  it('rejects when the KS does not know the resource', async () => {
    await expect(transport.getBinary(makeResourceId('res-unknown'))).rejects.toThrow('Resource not found');
  });

  it('rejects putBinary — workers are content readers', async () => {
    await expect(
      transport.putBinary({ name: 'x', format: 'text/plain', storageUri: 'file://x', file: Buffer.from('x') }),
    ).rejects.toThrow('does not support putBinary');
  });
});
