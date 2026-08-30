/**
 * `HttpContentTransport.getAnchoredText` / `putAnchoredText` — the coordinate
 * map crossing HTTP.
 *
 * This pair exists because the Smelter derives the map in its own process and
 * the gateway serves it, so the two cannot share a store the way an in-process
 * caller does. `LocalContentTransport` answers the same interface without any
 * of this, which is exactly why the HTTP half needs its own tests: the suites
 * in `@semiont/make-meaning` exercise the local implementation and would stay
 * green with every line below broken.
 *
 * The weight here is on **how "no map" arrives**. It is the common answer — a
 * native text layer is read in the browser, and a media type with no extractor
 * never produces one — so it must not read as a failure. It arrives as 204,
 * with no body, and a body-parsing read of that response throws.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { baseUrl, resourceId, type ExtractionOutcome } from '@semiont/core';
import type { KyInstance } from 'ky';

vi.mock('ky', () => ({ default: { create: vi.fn() } }));

import ky from 'ky';
import { HttpTransport } from '../http-transport';
import { HttpContentTransport } from '../http-content-transport';
import { BehaviorSubject } from 'rxjs';

// The transport constructs with a live token, so its bus actor auto-starts and
// would otherwise issue a real /bus/subscribe fetch. Park it forever.
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

const testBaseUrl = baseUrl('http://test.example.com');
const RID = resourceId('res-1');

const MAP: ExtractionOutcome = {
  kind: 'extracted',
  text: 'alpha beta',
  items: [{ start: 0, end: 5, page: 1, x: 72, y: 700, width: 28, height: 12 }],
  method: 'ocr',
};

/** A ky-shaped GET response: `status`/`ok` read directly, body via `.json()`. */
const response = (status: number, body?: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: vi.fn().mockResolvedValue(body),
});

function makeContent() {
  // Parameters declared so `put.mock.calls` is a typed tuple at the assertion
  // site rather than `[]`, which no cast can honestly narrow.
  const put = vi.fn((_url: string, _options: { headers: Record<string, string>; json: unknown }) => ({
    json: vi.fn().mockResolvedValue(undefined),
  }));
  const mockKy: Partial<KyInstance> = {
    get: vi.fn(),
    put: put as never,
    post: vi.fn(),
    extend: vi.fn(() => mockKy as KyInstance),
  };
  vi.mocked(ky.create).mockReturnValue(mockKy as KyInstance);

  const transport = new HttpTransport({
    baseUrl: testBaseUrl,
    token$: new BehaviorSubject<string | null>('test-token-abc') as never,
  });
  return { content: new HttpContentTransport(transport), mockKy, put };
}

describe('HttpContentTransport.getAnchoredText', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('returns the map on 200', async () => {
    const { content, mockKy } = makeContent();
    vi.mocked(mockKy.get!).mockResolvedValue(response(200, MAP) as never);

    await expect(content.getAnchoredText(RID)).resolves.toEqual(MAP);
  });

  test('asks the resource-scoped path, and does not throw on error statuses', async () => {
    // `throwHttpErrors: false` is load-bearing: this method decides what a
    // non-2xx means, and ky's default would reject before it could.
    const { content, mockKy } = makeContent();
    vi.mocked(mockKy.get!).mockResolvedValue(response(200, MAP) as never);

    await content.getAnchoredText(RID);

    expect(mockKy.get).toHaveBeenCalledWith(
      'http://test.example.com/resources/res-1/anchored-text',
      expect.objectContaining({ throwHttpErrors: false }),
    );
  });

  test('answers null on 204 WITHOUT reading the body', async () => {
    // The 204 carries no body. Parsing one is not merely wasteful — it throws,
    // which would turn the ordinary "this document has no map" into an error
    // and strip the quoted text from every annotation on the page.
    const { content, mockKy } = makeContent();
    const res = response(204);
    vi.mocked(mockKy.get!).mockResolvedValue(res as never);

    await expect(content.getAnchoredText(RID)).resolves.toBeNull();
    expect(res.json).not.toHaveBeenCalled();
  });

  test('answers null on 404 — a resource with no map either', async () => {
    const { content, mockKy } = makeContent();
    vi.mocked(mockKy.get!).mockResolvedValue(response(404) as never);

    await expect(content.getAnchoredText(RID)).resolves.toBeNull();
  });

  test('throws on a real failure rather than degrading to "no map"', async () => {
    // A 500 is not an answer about the document. Swallowing it here would make
    // a broken gateway look like a corpus of documents that simply have no
    // geometry — silently, and identically, for every resource.
    const { content, mockKy } = makeContent();
    vi.mocked(mockKy.get!).mockResolvedValue(response(500) as never);

    await expect(content.getAnchoredText(RID)).rejects.toThrow('anchored-text read failed: 500');
  });

  test('keeps an empty map distinct from no map', async () => {
    // A recognition pass that recovered nothing is a stored result, and the
    // 200 that carries it must not collapse into the 204 above.
    const { content, mockKy } = makeContent();
    const empty: ExtractionOutcome = { kind: 'extracted', text: '', items: [], method: 'ocr' };
    vi.mocked(mockKy.get!).mockResolvedValue(response(200, empty) as never);

    await expect(content.getAnchoredText(RID)).resolves.toEqual(empty);
  });
});

describe('HttpContentTransport.putAnchoredText', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // Writes are checksum-addressed (PERSIST-ANCHORS P1b): the producer files
  // the map under the identity of the bytes it read, never the mutable rid.
  const CHECKSUM = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  test('publishes the map to the checksum-addressed path as JSON', async () => {
    const { content, put } = makeContent();

    await content.putAnchoredText(CHECKSUM, MAP);

    expect(put).toHaveBeenCalledWith(
      `http://test.example.com/anchored-text/${CHECKSUM}`,
      expect.objectContaining({ json: MAP }),
    );
  });

  test('carries the caller-supplied token', async () => {
    // The route admits agents only, so the Smelter's own credential has to
    // reach it — the ambient session token is not what authorises this write.
    const { content, put } = makeContent();

    await content.putAnchoredText(CHECKSUM, MAP, { auth: 'smelter-token' as never });

    const [, options] = put.mock.calls[0]!;
    expect(options.headers['Authorization']).toBe('Bearer smelter-token');
  });
});
