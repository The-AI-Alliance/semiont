/**
 * Bytes in and out: `POST /resources`, the pipe at `GET /resources/{id}` and
 * its media-token alias, the JSON-LD description, and a resource's anchored
 * text. The gateway stores nothing and records nothing: it forwards an upload
 * to the Archivist, which stores the bytes and records the resource, and
 * reads bytes, descriptions and anchored text back from it (the fake
 * Archivist in harness/archivist.ts).
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { call, nonConformance } from '../harness/http';
import { SERVICE_ROLE, WORKER_ROLE } from '../harness/roles';
import { identifiers, spec } from '../harness/spec';
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
    const listener = await world().agent('listener');
    requests = await world().subscribe(listener.token, { clientId: randomUUID(), global: REQUESTS }, world().origin, true);
  });

  it('an upload goes to the Archivist whole, named for the uploader, and answers the id it recorded', async () => {
    const token = await world().person('uploader', { name: 'Una Uploader' });
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: ['principal:profile'] });
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

    const profile = await watcher.frame('principal:profile', (f) => f.payload['_userId'] === world().personDid('uploader'));
    expect(profile.payload['name']).toBe('Una Uploader');

    const back = await call(world().origin, 'GET', `/resources/${recorded.resourceId}`, { token });
    expect(back.bytes.equals(EVERY_BYTE)).toBe(true);
  });

  it('a worker\'s upload carries its roles to the record, and its token, carrying no name, publishes no profile', async () => {
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: ['principal:profile'] });
    const worker = await world().agent('uploading-model', [SERVICE_ROLE, WORKER_ROLE]);
    const reply = await call(world().origin, 'POST', '/resources', {
      token: worker.token,
      body: upload({ name: 'Generated', format: 'text/markdown', storageUri: `file://uploads/${randomUUID()}.md`, jobId: 'job-2' }, { bytes: Buffer.from('# generated'), type: 'text/markdown' }),
    });
    expect(reply.status, reply.text).toBe(202);
    const recorded = world().archivist.uploads.at(-1)!;
    expect(recorded.principal).toBe(worker.did);
    // The roles its account holds, as its token carries them.
    expect(recorded.roles).toBe([SERVICE_ROLE, WORKER_ROLE].join(','));
    await watcher.quiet('principal:profile', 500);
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
    const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: ['principal:profile'] });
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
    await watcher.quiet('principal:profile', 500, (f) => f.payload['_userId'] === world().personDid('refused-uploader'));
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
    const worker = await world().agent('reading-model', [SERVICE_ROLE, WORKER_ROLE]);

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
        });
        world().archivist.annotations.set(id, { annotations: [], total: 0 });
        world().archivist.anchoredTexts.set(id, { kind: 'no-map' });
      }
      const asked = world().archivist.calls.length;
      for (const path of ['/resources/{id}', '/resources/{id}/jsonld', '/resources/{id}/annotations', '/resources/{id}/anchored-text', '/api/resources/{id}'] as const) {
        const reply = await call(world().origin, 'GET', path.replace('{id}', segment), { token });
        expect(reply.status, `${path} with ${segment}: ${why}`).toBe(404);
        expect(nonConformance('get', path, reply), `${path} with ${segment}: ${why}`).toEqual([]);
      }
      expect(world().archivist.calls.slice(asked).map((c) => c.path), `${segment}: ${why}`).toEqual([]);
    }
  });

  it('the pipe, the description, the annotations and the anchored text answer 503 when the Archivist cannot serve them', async () => {
    const token = await world().person('reader');
    world().archivist.mode.refusesGateway = true;
    try {
      for (const path of ['/resources/{id}', '/resources/{id}/jsonld', '/resources/{id}/annotations', '/resources/{id}/anchored-text'] as const) {
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
    };
    world().archivist.descriptions.set(id, description);
    const token = await world().person('reader');
    const reply = await call(world().origin, 'GET', `/resources/${id}/jsonld`, { token });
    expect(reply.status, reply.text).toBe(200);
    expect(nonConformance('get', '/resources/{id}/jsonld', reply)).toEqual([]);
    expect(reply.headers.get('content-type')).toMatch(/^application\/ld\+json/);
    expect(reply.json).toEqual(description);
  });

  it('a resource\'s annotations are the record\'s answer, passed through unread and never cached, and 404 for an unknown resource', async () => {
    const id = `res-${randomUUID()}`;
    const held = { annotations: [], total: 0 };
    world().archivist.annotations.set(id, held);
    const token = await world().person('reader');
    const reply = await call(world().origin, 'GET', `/resources/${id}/annotations`, { token });
    expect(reply.status, reply.text).toBe(200);
    expect(nonConformance('get', '/resources/{id}/annotations', reply)).toEqual([]);
    expect(reply.headers.get('content-type')).toBe('application/json');
    expect(reply.headers.get('cache-control')).toBe('no-cache');
    expect(reply.json).toEqual(held);

    const unknown = await call(world().origin, 'GET', `/resources/res-${randomUUID()}/annotations`, { token });
    expect(unknown.status).toBe(404);
    expect(nonConformance('get', '/resources/{id}/annotations', unknown)).toEqual([]);
  });

  it('the JSON-LD description of an unknown resource is a 404', async () => {
    const token = await world().person('reader');
    const reply = await call(world().origin, 'GET', `/resources/res-${randomUUID()}/jsonld`, { token });
    expect(reply.status).toBe(404);
    expect(nonConformance('get', '/resources/{id}/jsonld', reply)).toEqual([]);
  });

  it('the anchored text is the Archivist\'s answer, byte for byte, never cached, and asked for as the gateway itself', async () => {
    const id = `res-${randomUUID()}`;
    // Its members in an order of their own, and an emoji: what reading the answer and writing it again could change.
    const answer = {
      kind: 'extracted',
      text: '😀 alpha',
      items: [
        { start: 0, end: 1, page: 1, x: 72, y: 700, width: 6, height: 12 },
        { start: 2, end: 7, page: 1, x: 72, y: 686, width: 30, height: 12 },
      ],
      method: 'ocr',
    };
    world().archivist.anchoredTexts.set(id, answer);
    const token = await world().person('reader');

    const reply = await call(world().origin, 'GET', `/resources/${id}/anchored-text`, { token });
    expect(reply.status, reply.text).toBe(200);
    expect(nonConformance('get', '/resources/{id}/anchored-text', reply)).toEqual([]);
    expect(reply.bytes.equals(Buffer.from(JSON.stringify(answer)))).toBe(true);
    expect(reply.headers.get('content-type')).toBe('application/json');
    expect(reply.headers.get('cache-control')).toBe('no-cache');

    const read = world().archivist.calls.findLast((c) => c.path === `/resources/${id}/anchored-text`);
    expect(read?.claims?.['azp']).toBe(GATEWAY_CLIENT);
  });

  it('the anchored text is read from the Archivist each time it is asked for: not-yet, and then the text', async () => {
    const id = `res-${randomUUID()}`;
    const text = { kind: 'extracted', text: 'alpha', items: [{ start: 0, end: 5, page: 1, x: 72, y: 700, width: 30, height: 12 }], method: 'pdf-text-layer' };
    let reads = 0;
    world().archivist.anchoredTexts.set(id, () => (reads++ === 0 ? { kind: 'not-yet' } : text));
    const token = await world().person('reader');

    for (const answer of [{ kind: 'not-yet' }, text]) {
      const reply = await call(world().origin, 'GET', `/resources/${id}/anchored-text`, { token });
      expect(reply.status, reply.text).toBe(200);
      expect(nonConformance('get', '/resources/{id}/anchored-text', reply)).toEqual([]);
      expect(reply.json).toEqual(answer);
    }
  });

  it('an absence and a decline are answers, not errors: unknown for a resource the Archivist does not hold, and what it answers for one it does', async () => {
    const token = await world().person('reader');
    const answered = async (id: string): Promise<unknown> => {
      const reply = await call(world().origin, 'GET', `/resources/${id}/anchored-text`, { token });
      expect(reply.status, reply.text).toBe(200);
      expect(nonConformance('get', '/resources/{id}/anchored-text', reply)).toEqual([]);
      return reply.json;
    };
    expect(await answered(`res-${randomUUID()}`)).toEqual({ kind: 'unknown' });
    for (const answer of [{ kind: 'no-map' }, { kind: 'declined', declined: 'encrypted' }]) {
      const id = `res-${randomUUID()}`;
      world().archivist.anchoredTexts.set(id, answer);
      expect(await answered(id)).toEqual(answer);
    }
  });

  it('the anchored text answers 503 when the Archivist\'s read of it fails', async () => {
    const token = await world().person('reader');
    world().archivist.mode.anchoredTextFails = true;
    try {
      const reply = await call(world().origin, 'GET', `/resources/res-${randomUUID()}/anchored-text`, { token });
      expect(reply.status).toBe(503);
      expect(nonConformance('get', '/resources/{id}/anchored-text', reply)).toEqual([]);
    } finally {
      world().archivist.mode.anchoredTextFails = false;
    }
  });

  it('the anchored text is refused without a token: a 401, and the Archivist is not asked', async () => {
    const id = `res-${randomUUID()}`;
    world().archivist.anchoredTexts.set(id, { kind: 'no-map' });
    const asked = world().archivist.calls.length;
    const reply = await call(world().origin, 'GET', `/resources/${id}/anchored-text`);
    expect(reply.status).toBe(401);
    expect(nonConformance('get', '/resources/{id}/anchored-text', reply)).toEqual([]);
    expect(world().archivist.calls.slice(asked).map((c) => c.path)).toEqual([]);
  });

  it('an anchored text larger than the largest bus message comes through whole', async () => {
    // No emit may be larger than this, so no reply on the bus could carry the answer below.
    const busMessageBytes = spec().limits('post', '/bus/emit')['maxBodyBytes']!;
    // Plain ASCII, forty lines to a page and one word to a line: each item's offsets index its word,
    // and each word's item is more than sixty bytes of the answer.
    const words = Array.from({ length: Math.ceil(busMessageBytes / 60) }, (_, index) => `word${index}`);
    let offset = 0;
    const items = words.map((word, index) => {
      const item = { start: offset, end: offset + word.length, page: Math.floor(index / 40) + 1, x: 72, y: 700 - (index % 40) * 14, width: word.length * 6, height: 12 };
      offset += word.length + 1;
      return item;
    });
    const answer = { kind: 'extracted', text: words.join(' '), items, method: 'pdf-text-layer' };
    const stored = Buffer.from(JSON.stringify(answer));
    expect(stored.length).toBeGreaterThan(busMessageBytes);

    const id = `res-${randomUUID()}`;
    world().archivist.anchoredTexts.set(id, answer);
    const reply = await call(world().origin, 'GET', `/resources/${id}/anchored-text`, { token: await world().person('reader') });
    expect(reply.status, reply.text.slice(0, 200)).toBe(200);
    expect(nonConformance('get', '/resources/{id}/anchored-text', reply)).toEqual([]);
    expect(reply.bytes.length).toBe(stored.length);
    expect(reply.bytes.equals(stored)).toBe(true);
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
