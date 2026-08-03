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
function appAs(agentDid: string | undefined, write = vi.fn()) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (agentDid) c.set('agentDid', agentDid);
    c.set('makeMeaning', { knowledgeSystem: { kb: { anchoredText: { write, read: vi.fn() } } } } as never);
    await next();
  });
  registerGetResourceUri(app as unknown as ResourcesRouterType);
  return { app, write };
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
