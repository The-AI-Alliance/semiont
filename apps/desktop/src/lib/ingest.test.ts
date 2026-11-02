import { describe, it, expect } from 'vitest';
import { createTestSession } from '@semiont/sdk/testing';
import { ingest, mimeTypeFor } from './ingest';
import { recordingContent } from './test-content';

// The real client over the scriptable stack: `yield.resource` is a pure CONTENT-seam
// conversation (putBinary → progress → resourceId), recorded by `recordingContent`;
// anything job-shaped would land in `transport.requestLog` — asserted absent.

function uploadHarness(opts: { resourceId: string; progress?: Array<{ bytesUploaded: number; totalBytes: number }> }) {
  const content = recordingContent({
    resourceIds: [opts.resourceId],
    ...(opts.progress !== undefined ? { progress: opts.progress } : {}),
  });
  const { session, transport } = createTestSession({ content: content.transport });
  const jobs = () => transport.requestLog.filter((e) => e.channel === 'job:create');
  return { session, content, jobs };
}

describe('ingest', () => {
  it('creates the resource from the bytes — plain, with no marking', async () => {
    const h = uploadHarness({ resourceId: 'res-42' });

    const result = await ingest(h.session, Buffer.from('doc body'), 'spec.md', {
      storageUri: 'file://spec.md',
      format: 'text/markdown',
    });

    expect(result).toEqual({ resourceId: 'res-42' });

    // The upload's own request shape — and NOT stamped with entity types (a source
    // document is not an entity instance; references are marked on demand later).
    expect(h.content.puts[0]).toEqual(
      expect.objectContaining({
        name: 'spec.md',
        file: expect.any(Buffer),
        format: 'text/markdown',
        storageUri: 'file://spec.md',
      }),
    );
    expect(h.content.puts[0]).not.toHaveProperty('entityTypes');

    // marking is no longer part of ingest — nothing job-shaped hit the wire
    expect(h.jobs()).toHaveLength(0);
    await h.session.dispose();
  });

  it('passes the given MIME format through, not a hardcoded one', async () => {
    const h = uploadHarness({ resourceId: 'img-1' });

    await ingest(h.session, Buffer.from('\x89PNG'), 'photo.png', {
      storageUri: 'file://uploads/photo.png',
      format: 'image/png',
    });

    expect(h.content.puts[0]).toEqual(expect.objectContaining({ format: 'image/png' }));
    await h.session.dispose();
  });

  it('forwards the upload byte-progress as a 0..1 fraction', async () => {
    const h = uploadHarness({
      resourceId: 'r1',
      progress: [
        { bytesUploaded: 25, totalBytes: 100 },
        { bytesUploaded: 100, totalBytes: 100 },
      ],
    });
    const fractions: number[] = [];

    await ingest(h.session, Buffer.from('x'), 'f.txt', {
      storageUri: 'file://f.txt',
      format: 'text/plain',
      onProgress: (f) => fractions.push(f),
    });

    expect(fractions).toEqual([0.25, 1]);
    await h.session.dispose();
  });
});

describe('mimeTypeFor', () => {
  it('maps known extensions, case-insensitively', () => {
    expect(mimeTypeFor('photo.JPG')).toBe('image/jpeg');
    expect(mimeTypeFor('scan.pdf')).toBe('application/pdf');
    expect(mimeTypeFor('notes.md')).toBe('text/markdown');
    expect(mimeTypeFor('clip.gif')).toBe('image/gif');
  });

  it('falls back to a generic binary type for unknowns', () => {
    expect(mimeTypeFor('archive.xyz')).toBe('application/octet-stream');
    expect(mimeTypeFor('noext')).toBe('application/octet-stream');
  });
});
