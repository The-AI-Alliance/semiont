/**
 * Lane 2 — persistence. The cache decided in ANCHORED-TEXT-CACHE.md Lane 0.
 *
 * The contract under test is deliberately stated as an OUTCOME — a second
 * extraction of identical content does not invoke the OCR engine — rather than
 * as a mechanism, so the seam can move without rewriting the spec.
 *
 * Two things it pins that a naive memoization would also pass, and must not:
 *
 *  - **It has to be on disk.** Removing the stored entry must make the engine
 *    run again. A module-level Map satisfies "second call is free" within one
 *    process and does nothing for the six separate passes this cache exists to
 *    collapse (five detection motivations plus the smelter, each its own job).
 *  - **A damaged entry is a miss, never an error.** Same rule extraction already
 *    follows for unreadable pages: the cache may make things faster, never
 *    make them fail.
 *
 * The key is supplied by the caller, not computed here. A content checksum
 * already exists upstream (`smelt:settled.contentChecksum`, `getChecksum`), and
 * hashing a large PDF per job is a cost this cache exists to remove, not add.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Count engine invocations without changing what it returns.
const recognizeSpy = vi.fn();
vi.mock('../ocr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ocr')>();
  return {
    ...actual,
    recognizeImages: (...args: Parameters<typeof actual.recognizeImages>) => {
      recognizeSpy();
      return actual.recognizeImages(...args);
    },
  };
});

const { EXTRACTORS } = await import('../content-extractor');
const { createAnchoredTextStore, encodeLines, decodeLines } = await import('../anchored-text-store');
const { calculateChecksum } = await import('../checksum');
const { locate, textUnder } = await import('@semiont/core');
type Item = import('@semiont/core').PdfTextItem;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const SCAN = fs.readFileSync(path.join(FIXTURES, 'scanned-image.pdf'));
const pdfExtractor = EXTRACTORS['pdf-text-layer']!;

let dir: string;
beforeEach(() => {
  recognizeSpy.mockClear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchored-text-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The codec is where a silent geometry bug would live: nothing downstream
 * re-derives these numbers, so a lossy round-trip reads as slightly wrong
 * annotation boxes forever rather than as a failure.
 *
 * Line records share `y`/`h` because word-height spread within a line measures
 * 0.0pt on real documents — but grouping is by *contiguous runs* of equal
 * `(y, h)`, so correctness never depends on that measurement holding. These
 * cases deliberately include input it does not hold for.
 */
describe('line-record codec', () => {
  const item = (over: Partial<Item>): Item =>
    ({ start: 0, end: 4, page: 1, x: 72, y: 700, width: 24, height: 12, ...over });

  const roundTrip = (items: Item[]) => decodeLines(encodeLines(items), items[0]?.page ?? 1);

  it('round-trips a plain line', () => {
    const items = [item({ start: 0, end: 5 }), item({ start: 6, end: 11, x: 106, width: 32 })];
    expect(roundTrip(items)).toEqual(items);
  });

  it('round-trips across lines and preserves order', () => {
    const items = [
      item({ start: 0, end: 5 }),
      item({ start: 6, end: 12, y: 688 }),
      item({ start: 13, end: 18, y: 700, x: 140 }),   // back up to the first line
    ];
    expect(roundTrip(items)).toEqual(items);
  });

  it('round-trips words whose heights differ within a line', () => {
    // Compression degrades to one record per word; the values must not.
    const items = [
      item({ start: 0, end: 3, height: 9 }),
      item({ start: 4, end: 7, x: 100, height: 14 }),
      item({ start: 8, end: 11, x: 130, height: 9 }),
    ];
    expect(roundTrip(items)).toEqual(items);
  });

  it('round-trips fractional and negative coordinates', () => {
    const items = [item({ x: -3.5, y: 71.25, width: 0.5, height: 11.75 })];
    expect(roundTrip(items)).toEqual(items);
  });

  it('round-trips an empty page', () => {
    expect(roundTrip([])).toEqual([]);
  });

  // Width is stored per word rather than inferred from the next word's x. If it
  // were inferred, each box would swell to touch its neighbour and every
  // coverage ratio RUN_COVERAGE_THRESHOLD is calibrated on would shift.
  it('preserves the gap between words, so coverage arithmetic is unchanged', () => {
    const text = 'alpha beta';
    const items = [
      item({ start: 0, end: 5, x: 72, width: 28 }),
      item({ start: 6, end: 10, x: 118, width: 22 }),   // 18pt gap
    ];
    const before = { text, items };
    const after = { text, items: roundTrip(items) };
    const { rects } = locate(before, 0, 5);
    expect(textUnder(after, rects[0]!)).toBe(textUnder(before, rects[0]!));
    expect(textUnder(after, rects[0]!)).toBe('alpha');
  });
});

/**
 * Lane 4 — hit rate in the operator log, so Lane 0's decision stays auditable
 * instead of becoming folklore.
 *
 * Logged by the store rather than at the call sites. Both `prepare-detection`
 * and the smelter call `extract()`, so logging at call sites would state the
 * same policy twice and each site would see only its own share of the traffic.
 */
describe('cache logging', () => {
  const logger = () => {
    const lines: { message: string; meta?: Record<string, unknown> }[] = [];
    const log = {
      debug: (message: string, meta?: Record<string, unknown>) => { lines.push({ message, meta }); },
      info: (message: string, meta?: Record<string, unknown>) => { lines.push({ message, meta }); },
      warn: () => {}, error: () => {}, child: () => log,
    };
    return { log, lines };
  };

  it('reports a miss and a hit for the same key', { timeout: 60_000 }, async () => {
    const { log, lines } = logger();
    const store = createAnchoredTextStore(dir, log as never);
    const key = calculateChecksum(SCAN);

    await pdfExtractor.extract(SCAN, 'application/pdf', { key, store });
    await pdfExtractor.extract(SCAN, 'application/pdf', { key, store });

    const outcomes = lines.map((l) => l.meta?.outcome);
    expect(outcomes).toEqual(['miss', 'hit']);
    expect(lines[1]!.meta?.key).toBe(key);
  });

  it('says nothing when no logger was given', { timeout: 60_000 }, async () => {
    // The store is used from a library; an operator decision about logging
    // belongs to whoever constructs it.
    const store = createAnchoredTextStore(dir);
    await pdfExtractor.extract(SCAN, 'application/pdf', { key: calculateChecksum(SCAN), store });
    expect(recognizeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('anchored-text cache', () => {
  it('does not re-run the engine for content it has already read', { timeout: 60_000 }, async () => {
    const store = createAnchoredTextStore(dir);
    const key = calculateChecksum(SCAN);

    const first = await pdfExtractor.extract(SCAN, 'application/pdf', { key, store });
    expect(recognizeSpy).toHaveBeenCalledTimes(1);

    const second = await pdfExtractor.extract(SCAN, 'application/pdf', { key, store });
    expect(recognizeSpy).toHaveBeenCalledTimes(1);   // still 1 — the second read was free
    expect(second).toEqual(first);
  });

  it('reads from disk, not from process memory', { timeout: 60_000 }, async () => {
    const store = createAnchoredTextStore(dir);
    const key = calculateChecksum(SCAN);

    await pdfExtractor.extract(SCAN, 'application/pdf', { key, store });
    expect(recognizeSpy).toHaveBeenCalledTimes(1);

    // The stored entry is the only thing standing between the second call and
    // the engine. Remove it and the engine must run again — which an in-memory
    // memo would not do, and which is the whole point: the six passes this
    // cache collapses are six separate jobs, not six calls in one process.
    for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry));

    await pdfExtractor.extract(SCAN, 'application/pdf', { key, store });
    expect(recognizeSpy).toHaveBeenCalledTimes(2);
  });

  /**
   * The stamp is what makes a change to the engine, the traineddata, or our own
   * offset construction safe to ship: an entry produced by different code must
   * not be served.
   *
   * "Not deleted" is the second half and matters as much. A miss that cleaned up
   * after itself would be an eviction policy smuggled into the read path —
   * running concurrently with any real one, and destroying entries a
   * *downgraded* deployment could still legitimately use.
   */
  it('misses cleanly on a stamp change, leaving the entry alone', { timeout: 60_000 }, async () => {
    const store = createAnchoredTextStore(dir);
    const key = calculateChecksum(SCAN);

    await pdfExtractor.extract(SCAN, 'application/pdf', { key, store });
    expect(recognizeSpy).toHaveBeenCalledTimes(1);

    const [name] = fs.readdirSync(dir);
    const file = path.join(dir, name!);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...entry, stamp: `${entry.stamp}-from-a-different-build` }));

    expect(await store.read(key)).toBeNull();
    await pdfExtractor.extract(SCAN, 'application/pdf', { key, store });
    expect(recognizeSpy).toHaveBeenCalledTimes(2);

    // Ignored, not reaped — and re-derived, so the current build's entry is back.
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).stamp).toBe(entry.stamp);
  });

  it('treats a corrupt entry as a miss rather than an error', { timeout: 60_000 }, async () => {
    const store = createAnchoredTextStore(dir);
    const key = calculateChecksum(SCAN);

    const first = await pdfExtractor.extract(SCAN, 'application/pdf', { key, store });
    for (const entry of fs.readdirSync(dir)) {
      fs.writeFileSync(path.join(dir, entry), '{ this is not json');
    }

    const second = await pdfExtractor.extract(SCAN, 'application/pdf', { key, store });
    expect(second).toEqual(first);
    expect(recognizeSpy).toHaveBeenCalledTimes(2);
  });

  it('extracts normally when given no cache at all', { timeout: 60_000 }, async () => {
    // The cache is optional: every existing caller passes nothing and must be
    // unaffected. This fixture's raster is a synthetic bitmap font, which the
    // recognizer correctly reads as nothing — so the unchanged behaviour being
    // asserted is the clean decline, the same one 22-pdf-scanned-decline
    // depends on. What matters here is that the engine still ran.
    const out = await pdfExtractor.extract(SCAN, 'application/pdf');
    expect(out).toEqual({ declined: 'no-text-layer' });
    expect(recognizeSpy).toHaveBeenCalledTimes(1);
  });

  // The negative is worth caching precisely because it is expensive: a scan the
  // engine cannot read costs a full recognition pass to discover, and without
  // an entry every one of the six passes rediscovers it. "We read this and
  // there was nothing" is a result.
  it('caches a page that recognized nothing, so it is not re-read six times', { timeout: 60_000 }, async () => {
    const store = createAnchoredTextStore(dir);
    const key = calculateChecksum(SCAN);

    expect(await pdfExtractor.extract(SCAN, 'application/pdf', { key, store }))
      .toEqual({ declined: 'no-text-layer' });
    expect(recognizeSpy).toHaveBeenCalledTimes(1);

    expect(await pdfExtractor.extract(SCAN, 'application/pdf', { key, store }))
      .toEqual({ declined: 'no-text-layer' });
    expect(recognizeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not touch the engine for a document with a text layer', { timeout: 60_000 }, async () => {
    // Class A never OCRs, so a cache entry would be storage spent on nothing.
    const native = fs.readFileSync(path.join(FIXTURES, 'single-line.pdf'));
    const store = createAnchoredTextStore(dir);

    await pdfExtractor.extract(native, 'application/pdf', { key: calculateChecksum(native), store });

    expect(recognizeSpy).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});
