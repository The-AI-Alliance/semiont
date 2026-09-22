/**
 * Create-route validation on POST /resources:
 * - format admission (MEDIA-TYPES.md Phase 3a): the base type must be a
 *   SupportedMediaType; unsupported base types 400 naming the offender;
 *   parameters survive validation ("text/plain; charset=iso-8859-1" is
 *   admitted and stored verbatim).
 * - storageUri is required: the client names the content's location and the
 *   bytes are stored there verbatim — the server does not derive a path.
 *   Omitting storageUri is a 400 (the typed PutBinaryRequest.storageUri is
 *   required, and every client supplies one).
 *
 * The write itself goes to the Archivist over HTTP (SINGLE-KB-MOUNT P2), so
 * `putContent` is what these tests stub — the same boundary the local
 * `kb.content.store` mock used to stand at, one seam further out.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Principal } from '../../identity/principal';
import { EventBus, userId } from '@semiont/core';
import type { EventBus as EventBusType } from '@semiont/core';
import { ResourceOperations } from '@semiont/make-meaning';
import { registerCreateResource } from '../../routes/resources/routes/create';
import type { ResourcesRouterType } from '../../routes/resources/shared';
import type { ArchivistAddressConfig } from '@semiont/core/node';
import { putContent } from '../../lib/archivist';

vi.mock('@semiont/make-meaning', () => ({
  ResourceOperations: {
    createResource: vi.fn(async () => 'res-created-1'),
  },
}));

vi.mock('../../lib/archivist', () => ({
  putContent: vi.fn(async (_config: unknown, storageUri: string) => ({
    storageUri,
    checksum: 'sha256:test',
    byteSize: 2,
    created: '2026-08-29T00:00:00.000Z',
  })),
}));

// `makeMeaning` is deliberately absent: the create route no longer touches it
// at all now that the bytes leave over HTTP. `config` is typed as the slice
// the route actually forwards rather than the whole EnvironmentConfig — a
// full one here would be noise, and asserting a fake into the wide type
// would hide a real mismatch instead of catching it.
type Variables = {
  principal: Principal;
  eventBus: EventBusType;
  config: ArchivistAddressConfig;
};

const putContentMock = vi.mocked(putContent);

function fakeUser(): Principal {
  return {
    did: userId(`did:web:${'test.local'}:users:${encodeURIComponent('test@test.local')}`),
    email: 'test@test.local',
    name: 'Test',
    domain: 'test.local',
  } as Principal;
}

const app = new Hono<{ Variables: Variables }>();
app.use('*', async (c, next) => {
  c.set('principal', fakeUser());
  c.set('eventBus', new EventBus());
  c.set('config', { services: { archivist: { host: 'archivist.test', port: 9999 } } });
  // The credential the Archivist-dialling routes resolve. A test can now
  // supply its own — it could not while the value was read from process.env.
  c.set('archivistCredential', () => ({
    issuer: 'http://issuer.test/realms/semiont',
    clientId: 'semiont-gateway',
    clientSecret: 'test-secret',
  }));
  await next();
});
registerCreateResource(app as unknown as ResourcesRouterType);

// storageUri defaults to a deliberately non-derivable path so the "stored
// verbatim" assertions can't be satisfied by accidental derivation. Pass
// storageUri: null to omit the field.
async function postResource(
  { format = 'text/markdown', storageUri = 'file://explicit-location.bin', jobId }:
  { format?: string; storageUri?: string | null; jobId?: string } = {},
) {
  const fd = new FormData();
  fd.set('name', 'My Doc');
  fd.set('file', new File([new Uint8Array([0x68, 0x69])], 'doc.bin'));
  fd.set('format', format);
  if (storageUri) fd.set('storageUri', storageUri);
  if (jobId) fd.set('jobId', jobId);
  return app.request('/resources', { method: 'POST', body: fd });
}

describe('POST /resources validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('400s when storageUri is omitted, before any side effect', async () => {
    const res = await postResource({ storageUri: null });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('storageUri');
    expect(putContentMock).not.toHaveBeenCalled();
    expect(ResourceOperations.createResource).not.toHaveBeenCalled();
  });

  it('400s on an unsupported base type, naming the offender, before any side effect', async () => {
    const res = await postResource({ format: 'application/x-not-a-thing' });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('application/x-not-a-thing');
    expect(putContentMock).not.toHaveBeenCalled();
    expect(ResourceOperations.createResource).not.toHaveBeenCalled();
  });

  it('stores at the client-supplied storageUri verbatim — never derives one', async () => {
    const res = await postResource({ format: 'text/markdown', storageUri: 'file://chosen/path.md' });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ resourceId: 'res-created-1' });
    expect(putContentMock).toHaveBeenCalledTimes(1);
    // putContent(config, credential, storageUri, body). Asserted by NAME
    // rather than by position: the credential became a parameter, and a
    // positional assertion silently moves to the wrong argument when a
    // signature grows.
    const [, credential, storageUri] = putContentMock.mock.calls[0]!;
    expect(storageUri).toBe('file://chosen/path.md');
    expect(credential).toMatchObject({ clientId: 'semiont-gateway' });
    expect(ResourceOperations.createResource).toHaveBeenCalledWith(
      expect.objectContaining({ storageUri: 'file://chosen/path.md' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('admits a parameterized format and stores it verbatim', async () => {
    const res = await postResource({
      format: 'text/plain; charset=iso-8859-1',
      storageUri: 'file://doc.txt',
    });

    expect(res.status).toBe(202);
    expect(ResourceOperations.createResource).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'text/plain; charset=iso-8859-1' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('forwards the job a worker cites onto the create, untouched', async () => {
    // The resource path is an HTTP upload, not a bus emit, so this route is
    // where the citation crosses from the worker's form field to the
    // yield:create the Stower derives provenance from. Dropping it here would
    // silently attribute a person's generation request to the model alone.
    const res = await postResource({ storageUri: 'file://gen.md', jobId: 'job-42' });

    expect(res.status).toBe(202);
    expect(ResourceOperations.createResource).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-42' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('forwards no job when none was cited — a person\'s own upload', async () => {
    const res = await postResource({ storageUri: 'file://mine.md' });

    expect(res.status).toBe(202);
    const [input] = vi.mocked(ResourceOperations.createResource).mock.calls[0]!;
    expect(input).not.toHaveProperty('jobId', expect.anything());
  });
});
