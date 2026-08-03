/**
 * Anchored-text cache — the persistent half of ANCHORED-TEXT-CACHE.md Lane 2.
 *
 * OCR costs ~2.9 s per scanned page, and six passes read the same document (five
 * detection motivations plus the smelter's embed), each its own job in its own
 * process. This stores what the engine produced so only the first pass pays.
 *
 * **Derived values only.** Everything here is reproducible from the source
 * bytes, which is what makes a stamp miss safe. An authored coordinate map is
 * embedded in the PDF Semiont generated, not stored alongside one — see
 * `PDF-GENERATION.md`, which owns that decision and states the negative:
 * never this store.
 *
 * The seam is the OCR boundary, not `extract()`: 82% of extraction time is
 * Tesseract, so the text-layer parse keeps running and only recognition is
 * skipped. A document with a text layer therefore stores nothing at all.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { isObject, isString, isNumber, isArray, type AnchoredText, type Logger, type PdfTextItem } from '@semiont/core';

/**
 * One line of recognized text: the geometry every word on it shares, plus the
 * per-word parts that differ.
 *
 * Grouping is by *contiguous runs* of equal `(y, h)`, never by scanning for all
 * items at a given y. That makes the codec lossless and order-preserving for
 * any input — compression is the only thing that depends on words actually
 * arriving in reading order, and correctness never is.
 *
 * Sharing `y`/`h` is measured-safe rather than assumed: within-line word-height
 * spread is 0.0pt in both native and OCR'd output, because the engine already
 * normalizes word boxes to the line. Per-word `x` and `width` are stored
 * explicitly and NOT derived from neighbouring split positions — deriving width
 * from the gap to the next word would widen every box to touch its neighbour,
 * which would silently change the coverage arithmetic `textUnder` is calibrated
 * on (RUN_COVERAGE_THRESHOLD, tuned against ink-tight boxes).
 */
export interface CachedLine {
    /** 1-indexed page. */
    p: number;
    /** PDF points, bottom-left origin — shared by every word on the line. */
    y: number;
    h: number;
    /** `[x, width, start, end]` per word; offsets index `CachedAnchoredText.text`. */
    words: [number, number, number, number][];
}

/**
 * The stored record: one `AnchoredText` for the whole resource.
 *
 * Whole-resource on every side, deliberately. The producer's own shape is a
 * per-page map, but that is an artifact of how `ocrPages` iterates, and letting
 * it reach storage would have forced every consumer — the transport, the
 * browser, a headless client — to reassemble pages it never asked to see.
 *
 * Per-word confidences are NOT stored. They are summarized and logged at
 * extraction, and a cache hit re-reporting identical numbers for identical
 * bytes carries no information; the consequence to know about is that
 * `ocrConfidence` is absent on a hit.
 */
export interface CachedAnchoredText {
    v: 1;
    /** Engine + traineddata + our assembly code. A mismatch is a clean miss. */
    stamp: string;
    text: string;
    lines: CachedLine[];
}

/**
 * What the cached value must be recomputed against.
 *
 * Derived, never hand-maintained. A hand-bumped counter fails in the one
 * direction that matters: forgetting to bump it does not cost a recomputation,
 * it silently serves geometry built by different code. Over-invalidating costs
 * seconds of the work this cache exists to avoid; under-invalidating is
 * corruption, so the stamp is deliberately over-eager — a release of this
 * package busts the cache whether or not assembly actually changed.
 *
 * `@semiont/content`'s own version covers our assembly code (`anchorRuns`,
 * `assemblePage`, `mapWordsToItems` — the offset construction IS part of what
 * the cached value means). The engine and its traineddata are read separately
 * because both are pinned with carets and can move without a release here —
 * and different traineddata means different recognized text, which is a
 * difference in the value itself, not merely in how fast it was produced.
 */
function buildStamp(): string {
    const require = createRequire(import.meta.url);
    const version = (specifier: string): string => {
        try {
            const pkg: unknown = require(specifier);
            return isObject(pkg) && isString(pkg.version) ? pkg.version : 'unknown';
        } catch {
            return 'unknown';
        }
    };
    return `content-${version('../package.json')}`
        + `+tesseract-${version('tesseract.js/package.json')}`
        + `+eng-${version('@tesseract.js-data/eng/package.json')}`;
}

const STAMP = buildStamp();

/** Pack items into line records. Lossless and order-preserving for any input. */
export function encodeLines(items: PdfTextItem[]): CachedLine[] {
    const lines: CachedLine[] = [];
    for (const item of items) {
        const last = lines[lines.length - 1];
        if (last && last.p === item.page && last.y === item.y && last.h === item.height) {
            last.words.push([item.x, item.width, item.start, item.end]);
        } else {
            lines.push({ p: item.page, y: item.y, h: item.height, words: [[item.x, item.width, item.start, item.end]] });
        }
    }
    return lines;
}

/** The inverse of `encodeLines`. */
export function decodeLines(lines: CachedLine[]): PdfTextItem[] {
    const items: PdfTextItem[] = [];
    for (const line of lines) {
        for (const [x, width, start, end] of line.words) {
            items.push({ start, end, page: line.p, x, y: line.y, width, height: line.h });
        }
    }
    return items;
}

export interface AnchoredTextStore {
    /** The stored map for this key, or null for any miss. Never throws. */
    read(key: string): Promise<AnchoredText | null>;
    /** Record a derived map. A store that cannot write is still a store. */
    write(key: string, anchored: AnchoredText): Promise<void>;
}

/** Narrow a parsed entry, so a truncated or foreign file is a miss, not a crash. */
function isCached(value: unknown): value is CachedAnchoredText {
    if (!isObject(value) || value.v !== 1 || !isString(value.stamp) || !isString(value.text) || !isArray(value.lines)) return false;
    return value.lines.every((line) =>
        isObject(line) && isNumber(line.p) && isNumber(line.y) && isNumber(line.h) && isArray(line.words)
        && line.words.every((w) => isArray(w) && w.length === 4 && w.every(isNumber)));
}

/**
 * A file-backed store under `dir` — one file per content key.
 *
 * `dir` is the caller's, out of `Project.dataHome`: this package has no idea
 * which project it is serving. Every failure path is a miss rather than an
 * error, matching the rule extraction already follows for unreadable pages —
 * the cache may make things faster, never make them fail.
 */
export function createAnchoredTextStore(dir: string, logger?: Logger): AnchoredTextStore {
    const fileFor = (key: string) => path.join(dir, `${key.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);

    return {
        async read(key) {
            let hit: CachedAnchoredText | null = null;
            try {
                const parsed: unknown = JSON.parse(await fs.promises.readFile(fileFor(key), 'utf8'));
                if (isCached(parsed) && parsed.stamp === STAMP) hit = parsed;
            } catch {
                hit = null;   // absent, unreadable, truncated, or not ours
            }
            // Logged here rather than at the call sites: `prepare-detection` and
            // the smelter both extract, so each would see only its own share of
            // the traffic and the policy would be stated twice. Hit rate is what
            // keeps the Lane 0 decision auditable after the fact.
            logger?.debug('Anchored-text cache', {
                outcome: hit ? 'hit' : 'miss',
                key,
                ...(hit ? { lines: hit.lines.length } : {}),
            });
            return hit ? { text: hit.text, items: decodeLines(hit.lines) } : null;
        },

        async write(key, anchored) {
            const entry: CachedAnchoredText = { v: 1, stamp: STAMP, text: anchored.text, lines: encodeLines(anchored.items) };
            const target = fileFor(key);
            // Write-then-rename: a reader never observes a half-written entry,
            // and two writers racing on the same key both produce the same bytes.
            const temp = `${target}.${process.pid}.tmp`;
            try {
                await fs.promises.mkdir(dir, { recursive: true });
                await fs.promises.writeFile(temp, JSON.stringify(entry), 'utf8');
                await fs.promises.rename(temp, target);
            } catch {
                await fs.promises.rm(temp, { force: true }).catch(() => {});
            }
        },
    };
}
