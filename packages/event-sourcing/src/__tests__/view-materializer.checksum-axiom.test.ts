/**
 * The content-checksum axiom: after ANY event that changes a resource's
 * bytes, the primary representation's `checksum` identifies the bytes the
 * resource actually has.
 *
 * One home, maintained on every path — the answer STORAGE-URI-ONE-HOME gave
 * for the sibling field, applied here. `ResourceDescriptor.currentChecksum`
 * used to be a second home: written on created/updated, never on cloned, and
 * read by nothing. The field readers DO use — the representation's — was
 * written on create and then never again.
 *
 * The consequence was live, not theoretical
 * (.plans/bugs/anchored-text-stale-primary-checksum.md): the anchored-text
 * read keys off `getPrimaryRepresentation(...).checksum`, while the Smelter
 * files geometry under the checksum of the bytes it actually read. From the
 * first update onward the two disagreed, so the read either served
 * coordinates for content the resource no longer had, or stalled the full
 * settle timeout and reported "no map" for a document that had one.
 *
 * An axiom rather than three separate cases: what must hold is a property of
 * every byte-changing path, and a per-case test is exactly what let the
 * update path be written without it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ViewMaterializer, FilesystemViewStorage } from '@semiont/event-sourcing';
import { SemiontProject } from '@semiont/core/node';
import { resourceId, getPrimaryRepresentation } from '@semiont/core';
import type { StoredEvent } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

describe('ViewMaterializer — the content-checksum axiom', () => {
  let testDir: string;
  let projector: ViewMaterializer;
  let project: SemiontProject;
  let viewStorage: FilesystemViewStorage;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-checksum-axiom-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    project = new SemiontProject(testDir, { anchoredTextDir: `${testDir}/anchored-text` });
    viewStorage = new FilesystemViewStorage(project);
    projector = new ViewMaterializer(viewStorage, { basePath: testDir });
  });

  afterEach(async () => {
    await project.destroy();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const stored = (event: Record<string, unknown>, sequenceNumber: number): StoredEvent => ({
    id: `event-${sequenceNumber}`,
    userId: 'user1',
    timestamp: new Date().toISOString(),
    version: 1,
    ...event,
    metadata: { sequenceNumber },
  } as unknown as StoredEvent);

  const RID = resourceId('res-checksum');

  const created = (checksum: string, seq: number) => stored({
    type: 'yield:created',
    resourceId: RID,
    payload: {
      name: 'Doc',
      format: 'application/pdf',
      contentChecksum: checksum,
      contentByteSize: 100,
      storageUri: 'file://docs/doc.pdf',
    },
  }, seq);

  const cloned = (checksum: string, seq: number) => stored({
    type: 'yield:cloned',
    resourceId: RID,
    payload: {
      name: 'Doc copy',
      format: 'application/pdf',
      contentChecksum: checksum,
      contentByteSize: 100,
      storageUri: 'file://docs/doc-copy.pdf',
      parentResourceId: 'res-parent',
    },
  }, seq);

  const updated = (checksum: string, seq: number) => stored({
    type: 'yield:updated',
    resourceId: RID,
    payload: { contentChecksum: checksum, contentByteSize: 250 },
  }, seq);

  async function viewAfter(events: StoredEvent[]) {
    const view = await projector.materialize(events, RID);
    if (!view) throw new Error('materialize returned no view');
    return view;
  }

  async function primaryChecksumAfter(events: StoredEvent[]): Promise<string | undefined> {
    return getPrimaryRepresentation((await viewAfter(events)).resource)?.checksum;
  }

  // ── the axiom, on every path that changes bytes ────────────────────────

  it('holds after a creation', async () => {
    expect(await primaryChecksumAfter([created('C1', 1)])).toBe('C1');
  });

  it('holds after a clone', async () => {
    expect(await primaryChecksumAfter([cloned('C1', 1)])).toBe('C1');
  });

  it('holds after an update — the case that was broken', async () => {
    // Before the fix this returned C1: the update wrote a different field and
    // left the representation carrying the ORIGINAL bytes' identity.
    expect(await primaryChecksumAfter([created('C1', 1), updated('C2', 2)])).toBe('C2');
  });

  it('holds after repeated updates', async () => {
    expect(await primaryChecksumAfter([
      created('C1', 1), updated('C2', 2), updated('C3', 3),
    ])).toBe('C3');
  });

  it('holds after an update to a CLONE', async () => {
    expect(await primaryChecksumAfter([cloned('C1', 1), updated('C2', 2)])).toBe('C2');
  });

  it('carries the new byteSize with the new checksum', async () => {
    // They describe the same bytes, so a path that refreshes one and not the
    // other leaves the descriptor internally inconsistent.
    const view = await viewAfter([created('C1', 1), updated('C2', 2)]);
    expect(getPrimaryRepresentation(view.resource)).toMatchObject({
      checksum: 'C2',
      byteSize: 250,
    });
  });

  it('leaves the byte LOCATION alone — an update replaces content in place', async () => {
    // The sibling field has its own event (`yield:moved`); an update must not
    // disturb it.
    const view = await viewAfter([created('C1', 1), updated('C2', 2)]);
    expect(getPrimaryRepresentation(view.resource)?.storageUri).toBe('file://docs/doc.pdf');
  });

  it('has no second home to disagree with', async () => {
    // `currentChecksum` is deleted from the schema. Its return — under any
    // name — reintroduces exactly this bug, because two fields cannot be kept
    // in step by convention.
    const view = await viewAfter([created('C1', 1), updated('C2', 2)]);
    expect(view.resource).not.toHaveProperty('currentChecksum');
  });

  // ── the clone's own fact ───────────────────────────────────────────────

  it('records a clone with the parent it came from', async () => {
    // The provenance half: a clone that materializes without its parent is
    // indistinguishable from a fresh upload.
    const view = await viewAfter([cloned('C1', 1)]);
    expect(view.resource.sourceResourceId).toBe('res-parent');
  });

  it('gives a clone a byte location', async () => {
    const view = await viewAfter([cloned('C1', 1)]);
    expect(getPrimaryRepresentation(view.resource)?.storageUri).toBe('file://docs/doc-copy.pdf');
  });
});
