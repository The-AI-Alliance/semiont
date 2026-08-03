/**
 * GET /resources/:id/anchored-text — reading a derived coordinate map.
 *
 * Three answers, and the whole point of this file is that they stay three.
 * "Here is the map", "no map was derived", and "no such resource" are
 * different facts, and a reader that cannot tell the second from the third
 * degrades identically but for the wrong reason.
 *
 * The second one is why these are status codes rather than a body. A JSON
 * `null` body under a 200 reads fine in TypeScript and lies in Go: oapi-codegen
 * unmarshals a 200 into `var dest AnchoredText`, and `encoding/json` documents
 * null-into-a-struct as a no-op, so the generated `JSON200` comes back non-nil
 * pointing at a zero value. "No map" and "a map of nothing" become the same
 * answer at exactly the layer that cannot investigate further. 204 has no body
 * to misread.
 *
 * A map of nothing is a real state, incidentally — the PUT route accepts one
 * deliberately (a recognition pass that recovered nothing is worth storing so
 * the next reader does not repeat it), which is what makes the confusion above
 * reachable rather than theoretical.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AnchoredText, EventBus as EventBusType } from '@semiont/core';
import type { User } from '@prisma/client';
import { registerGetResourceUri } from '../../routes/resources/routes/get-uri';
import type { ResourcesRouterType } from '../../routes/resources/shared';

const { eventBusRequest } = vi.hoisted(() => ({ eventBusRequest: vi.fn() }));
vi.mock('../../utils/event-bus-request', () => ({ eventBusRequest }));

type Variables = {
  user: User;
  principalDid: string;
  agentDid?: string;
  eventBus: EventBusType;
  makeMeaning: unknown;
};

const MAP: AnchoredText = {
  text: 'alpha beta',
  items: [{ start: 0, end: 5, page: 1, x: 72, y: 700, width: 28, height: 12 }],
};

function app() {
  const instance = new Hono<{ Variables: Variables }>();
  instance.use('*', async (c, next) => {
    c.set('eventBus', {} as EventBusType);
    await next();
  });
  registerGetResourceUri(instance as unknown as ResourcesRouterType);
  return instance;
}

const get = () => app().request('/resources/res-1/anchored-text');

describe('GET /resources/:id/anchored-text', () => {
  beforeEach(() => eventBusRequest.mockReset());

  it('serves the map as 200 when one has been derived', async () => {
    eventBusRequest.mockResolvedValue(MAP);

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MAP);
  });

  it('answers 204 with an empty body when no map has been derived', async () => {
    eventBusRequest.mockResolvedValue(null);

    const res = await get();

    expect(res.status).toBe(204);
    // Empty, not the four bytes "null" — the distinction this code exists for.
    expect(await res.text()).toBe('');
  });

  it('distinguishes an empty map from no map', async () => {
    // Both are 200-with-a-body vs 204-with-none. A client that only checked
    // for a falsy `text` would collapse them; the status code does not.
    const empty: AnchoredText = { text: '', items: [] };
    eventBusRequest.mockResolvedValue(empty);

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(empty);
  });

  it('answers 404 when the resource itself is absent', async () => {
    // Thrown per call, not `mockRejectedValue`: that builds the rejected
    // promise when the mock is configured, and nothing has awaited it yet,
    // so the runner flags an unhandled rejection and fails a passing test.
    eventBusRequest.mockImplementation(async () => { throw new Error('Resource not found'); });

    expect((await get()).status).toBe(404);
  });

  it('does not swallow an unexpected bus failure as "no map"', async () => {
    // A broken projection must not read as a document that simply has no
    // geometry — that is the failure mode 204 would hide if it were the
    // catch-all rather than a deliberate answer.
    eventBusRequest.mockImplementation(async () => { throw new Error('bus exploded'); });

    expect((await get()).status).toBe(500);
  });
});
