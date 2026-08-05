/**
 * PUT /anchored-text/:checksum — publishing a derived coordinate map, keyed by
 * the content checksum of the bytes it was derived from (PERSIST-ANCHORS P1b).
 *
 * The Smelter is the sole producer: it is the only process that reads a
 * representation's bytes at ingest, so it is the only one positioned to derive
 * a map cheaply. It runs separately from the backend, which is why this crosses
 * HTTP at all rather than writing the store the way an in-process caller does.
 *
 * Two things carry weight here and neither is the happy path:
 *
 *   - **Agents only.** A map decides where annotation rectangles land for
 *     everyone reading a document. A browser session that could write one could
 *     move every quote in it. `principalDid` erases the human/software
 *     distinction on purpose, so the route checks `agentDid`.
 *   - **The body is geometry.** An item missing `page`, or carrying `x` as a
 *     string, would store happily and then place a rectangle nowhere — noticed
 *     much later by a reader who cannot tell a bad write from a bad recognizer.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { ExtractionOutcome } from '@semiont/core';
import type { User } from '@prisma/client';
import type { EventBus as EventBusType } from '@semiont/core';
import { registerGetResourceUri } from '../../routes/resources/routes/get-uri';
import type { ResourcesRouterType } from '../../routes/resources/shared';

type Variables = {
  user: User;
  principalDid: string;
  agentDid?: string;
  eventBus: EventBusType;
  makeMeaning: unknown;
};

const MAP: ExtractionOutcome = {
  text: 'alpha beta',
  items: [{ start: 0, end: 5, page: 1, x: 72, y: 700, width: 28, height: 12 }],
  method: 'ocr',
};

/** An app whose principal is, or is not, a Software peer. */
function appAs(agentDid: string | undefined, write = vi.fn(), read = vi.fn(), list = vi.fn()) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (agentDid) c.set('agentDid', agentDid);
    c.set('makeMeaning', { knowledgeSystem: { kb: { anchoredText: { write, read, list } } } } as never);
    await next();
  });
  registerGetResourceUri(app as unknown as ResourcesRouterType);
  return { app, write, read, list };
}

// The producer addresses the artifact by the checksum of the bytes it read.
const CHECKSUM = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const put = (app: Hono<{ Variables: Variables }>, body: unknown) =>
  app.request(`/anchored-text/${CHECKSUM}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('PUT /anchored-text/:checksum', () => {
  beforeAll(() => vi.clearAllMocks());

  it('stores a map published by an agent', async () => {
    const { app, write } = appAs('did:semiont:agent:smelter');

    const res = await put(app, MAP);

    expect(res.status).toBe(204);
    expect(write).toHaveBeenCalledWith(CHECKSUM, MAP);
  });

  it('refuses a caller that is not an agent', async () => {
    // Authenticated, but a person. The map must not be writable from a browser.
    const { app, write } = appAs(undefined);

    const res = await put(app, MAP);

    expect(res.status).toBe(403);
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects a body whose items are not geometry', async () => {
    const { app, write } = appAs('did:semiont:agent:smelter');

    // `method` present so these reach the geometry checks — the point of the
    // test is item-field narrowing, not the provenance gate.
    const missingPage = { text: 'a', method: 'ocr', items: [{ start: 0, end: 1, x: 1, y: 2, width: 3, height: 4 }] };
    const stringCoordinate = { text: 'a', method: 'ocr', items: [{ start: 0, end: 1, page: 1, x: '72', y: 2, width: 3, height: 4 }] };

    expect((await put(app, missingPage)).status).toBe(400);
    expect((await put(app, stringCoordinate)).status).toBe(400);
    expect((await put(app, { text: 'a' })).status).toBe(400);
    expect((await put(app, 'not an object')).status).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects a body without provenance, and outside the enums', async () => {
    // The record is the extraction OUTCOME (PERSIST-ANCHORS D1): geometry
    // alone — the pre-P2a shape — is no longer a valid write.
    const { app, write } = appAs('did:semiont:agent:smelter');

    expect((await put(app, { text: 'a', items: [] })).status).toBe(400);
    expect((await put(app, { text: 'a', items: [], method: 'divination' })).status).toBe(400);
    expect((await put(app, { declined: 'sheer-boredom' })).status).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects a pdfClass outside the schema enum, accepts one inside it', async () => {
    // `pdfClass` is an enum (A–G) on the ExtractionOutcome schema. Accepting
    // arbitrary values here stores outcomes the OpenAPI contract forbids, and
    // downstream consumers that switch on A–G would meet a class they cannot
    // handle — the same bad-write-vs-bad-recognizer ambiguity as the geometry
    // checks above.
    const { app, write } = appAs('did:semiont:agent:smelter');

    expect((await put(app, { ...MAP, pdfClass: 'Z' })).status).toBe(400);
    expect((await put(app, { ...MAP, pdfClass: 7 })).status).toBe(400);
    expect(write).not.toHaveBeenCalled();

    const classified: ExtractionOutcome = { ...MAP, pdfClass: 'B' };
    expect((await put(app, classified)).status).toBe(204);
    expect(write).toHaveBeenCalledWith(CHECKSUM, classified);
  });

  it('rejects a checksum that is not lowercase hex SHA-256, rather than 204-ing a write that never happened', async () => {
    // The store refuses a key it cannot shard and RETURNS — "a store that
    // cannot write is still a store" is right for a cache library, but through
    // a PUT it is a lie: 204 tells the Smelter the map is published while the
    // artifact is permanently absent, and the reconcile diff can never see the
    // hole because nothing was ever recorded. The route owes a 400.
    //
    // Lowercase specifically: `calculateChecksum` is sha256().digest('hex'), and
    // the store shards on the key's first characters — accepting `AB…` and `ab…`
    // would file one content identity under two different paths.
    const { app, write } = appAs('did:semiont:agent:smelter');

    const bad = [
      'not-a-checksum',
      'a'.repeat(63),           // one short
      'a'.repeat(65),           // one long
      'A'.repeat(64),           // uppercase — a second path for the same content
      `${'a'.repeat(62)}zz`,    // right length, not hex
      // An empty segment is not in this list: `/anchored-text/` does not match
      // `/anchored-text/:checksum`, so routing 404s it before the handler runs.
    ];
    for (const checksum of bad) {
      const res = await app.request(`/anchored-text/${checksum}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(MAP),
      });
      expect(res.status, `PUT with checksum "${checksum}"`).toBe(400);
    }
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects a bad checksum on the cache-consult read too, instead of answering "no map"', async () => {
    // A 204 here means "this content has no extraction", which a malformed key
    // has not established. Answering it hides the caller's bug as a cache miss.
    const { app, read } = appAs('did:semiont:agent:smelter');

    const res = await app.request('/anchored-text/not-a-checksum', { method: 'GET' });
    expect(res.status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects fractional values in the fields the schema types as integer', async () => {
    // `unreadPages[]`, `ocrConfidence.lowConfidenceWords` and `.totalWords` are
    // `integer` in the schema; `mean` is `number`. Counting words to 3.7 or
    // naming page 1.5 is a broken recognizer, and storing it hands the reader
    // the same bad-write-vs-bad-recognizer ambiguity the geometry checks exist
    // to prevent. (The `items` geometry is deliberately NOT tightened: the
    // schema types every PdfTextItem field — `page` included — as `number`, so
    // rejecting fractions there would make this guard stricter than the
    // contract it enforces.)
    const { app, write } = appAs('did:semiont:agent:smelter');

    expect((await put(app, { ...MAP, unreadPages: [1.5] })).status).toBe(400);
    expect((await put(app, {
      ...MAP,
      ocrConfidence: { mean: 91.2, lowConfidenceWords: 3.7, totalWords: 100 },
    })).status).toBe(400);
    expect((await put(app, {
      ...MAP,
      ocrConfidence: { mean: 91.2, lowConfidenceWords: 3, totalWords: 100.5 },
    })).status).toBe(400);
    expect(write).not.toHaveBeenCalled();

    // Integers pass, and a fractional `mean` still passes — it is a number.
    const measured: ExtractionOutcome = {
      ...MAP,
      unreadPages: [2, 7],
      ocrConfidence: { mean: 91.2, lowConfidenceWords: 3, totalWords: 100 },
    };
    expect((await put(app, measured)).status).toBe(204);
    expect(write).toHaveBeenCalledWith(CHECKSUM, measured);
  });

  it('stores a named decline — a cacheable outcome, not an error', async () => {
    const { app, write } = appAs('did:semiont:agent:smelter');

    const decline: ExtractionOutcome = { declined: 'no-text-layer' };
    expect((await put(app, decline)).status).toBe(204);
    expect(write).toHaveBeenCalledWith(CHECKSUM, decline);
  });

  it('accepts a map with no items', async () => {
    // An extraction that recovered nothing is a result worth storing: it is
    // what stops the next reader paying for the same recognition pass.
    const { app, write } = appAs('did:semiont:agent:smelter');

    const empty: ExtractionOutcome = { text: '', items: [], method: 'ocr' };
    expect((await put(app, empty)).status).toBe(204);
    expect(write).toHaveBeenCalledWith(CHECKSUM, empty);
  });
});

describe('GET /anchored-text/:checksum — the cache-consult read (PERSIST-ANCHORS P2c)', () => {
  const get = (app: Hono<{ Variables: Variables }>) =>
    app.request(`/anchored-text/${CHECKSUM}`, { method: 'GET' });

  it('serves the stored outcome to an agent', async () => {
    const read = vi.fn().mockResolvedValue(MAP);
    const { app } = appAs('did:semiont:agent:smelter', vi.fn(), read);

    const res = await get(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MAP);
    expect(read).toHaveBeenCalledWith(CHECKSUM);
  });

  it('answers 204 on a miss — the ordinary cache outcome, not an error', async () => {
    const read = vi.fn().mockResolvedValue(null);
    const { app } = appAs('did:semiont:agent:smelter', vi.fn(), read);

    const res = await get(app);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('refuses a caller that is not an agent', async () => {
    const read = vi.fn();
    const { app } = appAs(undefined, vi.fn(), read);

    expect((await get(app)).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it('does not shadow the keys listing — /anchored-text/keys still answers as itself', async () => {
    // Static-over-dynamic route precedence, pinned: a checksum route that
    // captured 'keys' would silently break the reconcile planner's bulk read.
    // The 200 is the discriminator — the checksum handler would have 400'd
    // 'keys' as a non-hex segment before ever touching the store.
    const read = vi.fn().mockResolvedValue(MAP);
    const list = vi.fn().mockResolvedValue([CHECKSUM]);
    const { app } = appAs('did:semiont:agent:smelter', vi.fn(), read, list);

    const res = await app.request('/anchored-text/keys', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keys: [CHECKSUM] });
    expect(read).not.toHaveBeenCalled();   // the checksum handler never saw 'keys'
  });
});
