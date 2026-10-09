/**
 * Bytes in and out: `POST /resources`, the pipe at `GET /resources/{id}` and
 * its media-token alias, and the JSON-LD description. The gateway stores
 * nothing and records nothing: it forwards an upload to the Archivist, which
 * stores the bytes and records the resource, and reads bytes and descriptions
 * back from it (the fake Archivist in harness/archivist.ts).
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { call, nonConformance } from '../harness/http';
import { SERVICE_ROLE, WORKER_ROLE } from '../harness/roles';
import { identifiers } from '../harness/spec';
import { eachPlane, GATEWAY_CLIENT } from '../harness/world';
import type { BusStream } from '../harness/stream';

/** Every byte value, several times: nothing may be decoded, re-encoded or trimmed. */
const EVERY_BYTE = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));

/** The requests an upload and a description once cost the gateway on the bus. */
const REQUESTS = ['yield:create', 'yield:clone-create', 'browse:resource-requested'];

function upload(fields: Record<string, string>, file?: { bytes: Buffer; type: string }): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set('file', new Blob([new Uint8Array(file.bytes)], { type: file.type }), 'upload.bin');
  return form;
}

eachPlane('content', (world) => {
  /** Hears every request channel an upload or a description could publish. */
  let requests: BusStream;

  beforeAll(async () => {
    const listener = await world().agent('conformance', 'listener');
    requests = await world().subscribe(listener.token, { clientId: randomUUID(), global: REQUESTS }, world().origin, true);
  });

  it('an upload goes to the Archivist whole, named for the uploader, and answers the id it recorded', async () => {
    const token = await world().person('uploader', { name: 'Una Uploader' });
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: ['person:profile'] });
    const storageUri = `file://uploads/${randomUUID()}.png`;
    const fields = {
      name: 'Every byte',
      format: 'image/png',
      storageUri,
      language: 'en',
      entityTypes: JSON.stringify(['Person', 'Place']),
      sourceResourceId: 'res-source',
      sourceAnnotationId: 'ann-source',
      generationPrompt: 'a prompt',
      generator: JSON.stringify({ '@type': 'Software', name: 'a model', provider: 'ollama', model: 'a-model' }),
      jobId: 'job-1',
      isDraft: 'true',
    };
    const reply = await call(world().origin, 'POST', '/resources', { token, body: upload(fields, { bytes: EVERY_BYTE, type: 'image/png' }) });
    expect(reply.status, reply.text).toBe(202);
    expect(nonConformance('post', '/resources', reply)).toEqual([]);

    const recorded = world().archivist.uploads.at(-1)!;
    expect(reply.json).toEqual({ resourceId: recorded.resourceId });
    expect(recorded.fields).toEqual(fields);
    expect(recorded.file.equals(EVERY_BYTE)).toBe(true);
    expect(recorded.principal).toBe(world().personDid('uploader'));
    expect(recorded.roles).toBeUndefined();
    const post = world().archivist.calls.findLast((c) => c.method === 'POST' && c.path === '/resources');
    expect(post?.claims?.['azp']).toBe(GATEWAY_CLIENT);

    const profile = await watcher.frame('person:profile', (f) => f.payload['_userId'] === world().personDid('uploader'));
    expect(profile.payload['name']).toBe('Una Uploader');

    const back = await call(world().origin, 'GET', `/resources/${recorded.resourceId}`, { token });
    expect(back.bytes.equals(EVERY_BYTE)).toBe(true);
  });

  it('a worker\'s upload carries its roles to the record, and names no person', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: ['person:profile'] });
    const worker = await world().agent('ollama', 'uploading-model', [SERVICE_ROLE, WORKER_ROLE]);
    const reply = await call(world().origin, 'POST', '/resources', {
      token: worker.token,
      body: upload({ name: 'Generated', format: 'text/markdown', storageUri: `file://uploads/${randomUUID()}.md`, jobId: 'job-2' }, { bytes: Buffer.from('# generated'), type: 'text/markdown' }),
    });
    expect(reply.status, reply.text).toBe(202);
    const recorded = world().archivist.uploads.at(-1)!;
    expect(recorded.principal).toBe(worker.did);
    expect(recorded.roles).toBe(WORKER_ROLE);
    await watcher.quiet('person:profile', 500);
  });

  it('an upload the Archivist finds malformed is a 400 carrying its reason', async () => {
    const token = await world().person('uploader');
    const bytes = { bytes: Buffer.from('x'), type: 'text/plain' };
    const cases: Array<[string, FormData, RegExp]> = [
      ['no name', upload({ format: 'text/plain', storageUri: 'file://a' }, bytes), /name/],
      ['no file', upload({ name: 'n', format: 'text/plain', storageUri: 'file://a' }), /file/],
      ['an unsupported media type', upload({ name: 'n', format: 'application/x-conformance', storageUri: 'file://a' }, bytes), /application\/x-conformance/],
    ];
    for (const [why, body, names] of cases) {
      const reply = await call(world().origin, 'POST', '/resources', { token, body });
      expect(reply.status, why).toBe(400);
      expect(nonConformance('post', '/resources', reply), why).toEqual([]);
      expect((reply.json as { error: string }).error, why).toMatch(names);
    }
  });

  it('an upload the record refuses is a 500 carrying its reason, and one the Archivist cannot take is a 503 — and neither names its uploader', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: ['person:profile'] });
    const token = await world().person('refused-uploader', { name: 'Rhea Refused' });
    const body = () => upload({ name: 'n', format: 'text/plain', storageUri: `file://uploads/${randomUUID()}` }, { bytes: Buffer.from('x'), type: 'text/plain' });
    world().archivist.mode.refuseUploads = 'a worker-role emitter must cite the job it fulfils';
    try {
      const refused = await call(world().origin, 'POST', '/resources', { token, body: body() });
      expect(refused.status).toBe(500);
      expect(nonConformance('post', '/resources', refused)).toEqual([]);
      expect((refused.json as { error: string }).error).toMatch(/must cite the job/);
    } finally {
      world().archivist.mode.refuseUploads = undefined;
    }

    world().archivist.mode.refusesGateway = true;
    try {
      const unavailable = await call(world().origin, 'POST', '/resources', { token, body: body() });
      expect(unavailable.status).toBe(503);
      expect(nonConformance('post', '/resources', unavailable)).toEqual([]);
    } finally {
      world().archivist.mode.refusesGateway = false;
    }
    await watcher.quiet('person:profile', 500, (f) => f.payload['_userId'] === world().personDid('refused-uploader'));
  });

  it('the pipe serves the stored bytes verbatim, with the stored media type and the declared headers', async () => {
    const id = `res-${randomUUID()}`;
    world().archivist.resources.set(id, { storageUri: `file://${id}`, mediaType: 'text/plain; charset=iso-8859-1' });
    world().archivist.content.set(`file://${id}`, EVERY_BYTE);
    const token = await world().person('reader');

    const reply = await call(world().origin, 'GET', `/resources/${id}`, { token, headers: { accept: 'application/ld+json' } });
    expect(reply.status).toBe(200);
    expect(nonConformance('get', '/resources/{id}', reply)).toEqual([]);
    expect(reply.bytes.equals(EVERY_BYTE)).toBe(true);
    expect(reply.headers.get('content-type')).toBe('text/plain; charset=iso-8859-1');
    expect(reply.headers.get('link')).toBe(`</resources/${id}/jsonld>; rel="describedby"; type="application/ld+json"`);

    const read = world().archivist.calls.findLast((c) => c.path === `/resources/${id}/content`);
    expect(read?.claims?.['azp']).toBe(GATEWAY_CLIENT);
  });

  it('the pipe serves a worker\'s agent the stored bytes, as it serves a person', async () => {
    const id = `res-${randomUUID()}`;
    world().archivist.resources.set(id, { storageUri: `file://${id}`, mediaType: 'text/markdown' });
    world().archivist.content.set(`file://${id}`, EVERY_BYTE);
    const worker = await world().agent('ollama', 'reading-model', [SERVICE_ROLE, WORKER_ROLE]);

    const reply = await call(world().origin, 'GET', `/resources/${id}`, { token: worker.token });
    expect(reply.status, reply.text).toBe(200);
    expect(nonConformance('get', '/resources/{id}', reply)).toEqual([]);
    expect(reply.bytes.equals(EVERY_BYTE)).toBe(true);
    expect(reply.headers.get('content-type')).toBe('text/markdown');

    // The Archivist is asked by the gateway, as itself: the worker shows the
    // Archivist nothing, and needs no address for it.
    const read = world().archivist.calls.findLast((c) => c.path === `/resources/${id}/content`);
    expect(read?.claims?.['azp']).toBe(GATEWAY_CLIENT);
  });

  it('the media alias serves the same bytes to a bearer or to the resource\'s media token', async () => {
    const id = `res-${randomUUID()}`;
    world().archivist.resources.set(id, { storageUri: `file://${id}`, mediaType: 'application/pdf' });
    world().archivist.content.set(`file://${id}`, EVERY_BYTE);
    const token = await world().person('reader');
    const media = ((await call(world().origin, 'POST', '/api/tokens/media', { token, json: { resourceId: id } })).json as { token: string }).token;

    for (const reply of [
      await call(world().origin, 'GET', `/api/resources/${id}`, { token }),
      await call(world().origin, 'GET', `/api/resources/${id}?token=${media}`),
    ]) {
      expect(reply.status).toBe(200);
      expect(nonConformance('get', '/api/resources/{id}', reply)).toEqual([]);
      expect(reply.bytes.equals(EVERY_BYTE)).toBe(true);
      expect(reply.headers.get('content-type')).toBe('application/pdf');
    }
  });

  it('the pipe answers 404 for an unknown resource, and for a resource without bytes', async () => {
    const token = await world().person('reader');
    const withoutBytes = `res-${randomUUID()}`;
    world().archivist.resources.set(withoutBytes, { storageUri: `file://${withoutBytes}`, mediaType: 'text/plain' });
    for (const [id, message] of [[`res-${randomUUID()}`, 'Resource not found'], [withoutBytes, 'Resource representation not found']] as const) {
      for (const path of ['/resources/{id}', '/api/resources/{id}'] as const) {
        const reply = await call(world().origin, 'GET', path.replace('{id}', id), { token });
        expect(reply.status, path).toBe(404);
        expect(nonConformance('get', path, reply), path).toEqual([]);
        expect((reply.json as { error?: string } | undefined)?.error, path).toBe(message);
      }
    }
  });

  it('a path that names what is not a resource\'s id names no resource: a 404, and the Archivist is not asked (identifiers/kinds.json)', async () => {
    const token = await world().person('reader');
    // Left out: the empty string, `.` and `..`, which a URL parser resolves
    // before the request is sent, so they reach no route.
    const named: Array<{ segment: string; id?: string; why: string }> = [
      ...identifiers('ResourceId')
        .refuses.filter(({ id }) => !['', '.', '..'].includes(id))
        .map(({ id, why }) => ({ segment: encodeURIComponent(id), id, why })),
      { segment: '%FF', why: 'bytes that are no text at all' },
    ];
    for (const { segment, id, why } of named) {
      // Stored under that very name, so an answer other than 404 would be its bytes.
      if (id !== undefined) {
        world().archivist.resources.set(id, { storageUri: `file://${segment}`, mediaType: 'text/plain' });
        world().archivist.content.set(`file://${segment}`, Buffer.from('bytes'));
        world().archivist.descriptions.set(id, {
          resource: { '@context': 'https://schema.org/', '@id': 'res-stored', name: 'Stored', representations: [] },
          annotations: [],
          entityReferences: [],
        });
      }
      const asked = world().archivist.calls.length;
      for (const path of ['/resources/{id}', '/resources/{id}/jsonld', '/api/resources/{id}'] as const) {
        const reply = await call(world().origin, 'GET', path.replace('{id}', segment), { token });
        expect(reply.status, `${path} with ${segment}: ${why}`).toBe(404);
        expect(nonConformance('get', path, reply), `${path} with ${segment}: ${why}`).toEqual([]);
      }
      expect(world().archivist.calls.slice(asked).map((c) => c.path), `${segment}: ${why}`).toEqual([]);
    }
  });

  it('the pipe and the description answer 503 when the Archivist cannot serve them', async () => {
    const token = await world().person('reader');
    world().archivist.mode.refusesGateway = true;
    try {
      for (const path of ['/resources/{id}', '/resources/{id}/jsonld'] as const) {
        const reply = await call(world().origin, 'GET', path.replace('{id}', `res-${randomUUID()}`), { token });
        expect(reply.status, path).toBe(503);
        expect(nonConformance('get', path, reply), path).toEqual([]);
      }
    } finally {
      world().archivist.mode.refusesGateway = false;
    }
  });

  it('the JSON-LD description is the record\'s answer, never cached', async () => {
    const id = `res-${randomUUID()}`;
    const description = {
      resource: { '@context': 'https://schema.org/', '@id': id, name: 'Described', representations: [{ mediaType: 'text/plain' }] },
      annotations: [],
      entityReferences: [],
    };
    world().archivist.descriptions.set(id, description);
    const token = await world().person('reader');
    const reply = await call(world().origin, 'GET', `/resources/${id}/jsonld`, { token });
    expect(reply.status, reply.text).toBe(200);
    expect(nonConformance('get', '/resources/{id}/jsonld', reply)).toEqual([]);
    expect(reply.headers.get('content-type')).toMatch(/^application\/ld\+json/);
    expect(reply.json).toEqual(description);
  });

  it('the JSON-LD description of an unknown resource is a 404', async () => {
    const token = await world().person('reader');
    const reply = await call(world().origin, 'GET', `/resources/res-${randomUUID()}/jsonld`, { token });
    expect(reply.status).toBe(404);
    expect(nonConformance('get', '/resources/{id}/jsonld', reply)).toEqual([]);
  });

  it('the gateway makes no bus request of its own: an upload and a description ask the Archivist over HTTP', async () => {
    const token = await world().person('uploader');
    await call(world().origin, 'POST', '/resources', {
      token,
      body: upload({ name: 'n', format: 'text/plain', storageUri: `file://uploads/${randomUUID()}` }, { bytes: Buffer.from('x'), type: 'text/plain' }),
    });
    await call(world().origin, 'POST', '/resources', {
      token,
      body: upload({ name: 'n', format: 'text/plain', storageUri: `file://uploads/${randomUUID()}`, cloneToken: 't' }, { bytes: Buffer.from('x'), type: 'text/plain' }),
    });
    await call(world().origin, 'GET', `/resources/res-${randomUUID()}/jsonld`, { token });
    await new Promise((r) => setTimeout(r, 300));
    expect(requests.frames().map((f) => f.channel)).toEqual([]);
  });
});
