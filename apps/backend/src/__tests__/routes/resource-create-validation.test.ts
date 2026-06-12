/**
 * Registry validation on POST /resources (.plans/MEDIA-TYPES.md, Phase 3a):
 * admission is gated on the format's base type being a SupportedMediaType.
 * Unsupported base types 400 naming the offender; parameters survive
 * validation ("text/plain; charset=iso-8859-1" is admitted, stored verbatim)
 * while the base type — not the parameterized string — names the storage URI.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@prisma/client';
import { EventBus } from '@semiont/core';
import type { EventBus as EventBusType } from '@semiont/core';
import { ResourceOperations } from '@semiont/make-meaning';
import { registerCreateResource } from '../../routes/resources/routes/create';
import type { ResourcesRouterType } from '../../routes/resources/shared';

vi.mock('@semiont/make-meaning', () => ({
  ResourceOperations: {
    createResource: vi.fn(async () => 'res-created-1'),
  },
}));

type Variables = { user: User; principalDid: string; eventBus: EventBusType; makeMeaning: unknown };

const storeMock = vi.fn(async (_content: Buffer, uri: string) => ({
  checksum: 'sha256:test',
  byteSize: 2,
  storageUri: uri,
}));

function fakeUser(): User {
  return {
    id: 'user-1',
    email: 'test@test.local',
    name: 'Test',
    domain: 'test.local',
    provider: 'worker',
    isAdmin: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as User;
}

const app = new Hono<{ Variables: Variables }>();
app.use('*', async (c, next) => {
  c.set('user', fakeUser());
  c.set('principalDid', 'did:web:test.local:users:test%40test.local');
  c.set('eventBus', new EventBus());
  c.set('makeMeaning', { knowledgeSystem: { kb: { content: { store: storeMock } } } });
  await next();
});
registerCreateResource(app as unknown as ResourcesRouterType);

async function postResource(format: string) {
  const fd = new FormData();
  fd.set('name', 'My Doc');
  fd.set('file', new File([new Uint8Array([0x68, 0x69])], 'doc.bin'));
  fd.set('format', format);
  return app.request('/resources', { method: 'POST', body: fd });
}

describe('POST /resources format validation (MEDIA-TYPES.md Phase 3a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('400s on an unsupported base type, naming the offender, before any side effect', async () => {
    const res = await postResource('application/x-not-a-thing');

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('application/x-not-a-thing');
    expect(storeMock).not.toHaveBeenCalled();
    expect(ResourceOperations.createResource).not.toHaveBeenCalled();
  });

  it('admits a registry member and derives the storage URI from it', async () => {
    const res = await postResource('text/markdown');

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ resourceId: 'res-created-1' });
    expect(storeMock).toHaveBeenCalledTimes(1);
    expect(storeMock.mock.calls[0]![1]).toBe('file://my-doc.md');
  });

  it('admits a parameterized format: base type names the URI, parameters stored verbatim', async () => {
    const res = await postResource('text/plain; charset=iso-8859-1');

    expect(res.status).toBe(202);
    expect(storeMock.mock.calls[0]![1]).toBe('file://my-doc.txt');
    expect(ResourceOperations.createResource).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'text/plain; charset=iso-8859-1' }),
      expect.anything(),
      expect.anything(),
    );
  });
});
