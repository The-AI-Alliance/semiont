/**
 * Anchored-text cache — the persistent half of ANCHORED-TEXT-CACHE.md Lane 2.
 *
 * OCR costs ~2.9 s per scanned page, and six passes read the same document (five
 * detection motivations plus the smelter's embed), each its own job in its own
 * process. This stores what the engine produced so only the first pass pays.
 *
 * **Derived values only.** Everything here is reproducible from the source
 * bytes, which is what makes eviction and a stamp miss safe. An *authored*
 * coordinate map — one Semiont generated and cannot recompute
 * (`PDF-GENERATION.md`) — is master data and must never be written here.
 *
 * The seam is the OCR boundary, not `extract()`: 82% of extraction time is
 * Tesseract, so the text-layer parse keeps running and only recognition is
 * skipped. A document with a text layer therefore stores nothing at all.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { isObject, isString, isNumber, isArray, type PdfTextItem } from '@semiont/core';

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
    /** PDF points, bottom-left origin — shared by every word on the line. */
    y: number;
    h: number;
    /** `[x, width, start, end]` per word; offsets index the page's own text. */
    words: [number, number, number, number][];
}

/** One page's recognition result, as `ocrPages` produces it. */
export interface CachedOcrPage {
    /** 1-indexed page number. */
    p: number;
    text: string;
    lines: CachedLine[];
    /** Per-word confidence in reading order, parallel to the words in `lines`. */
    conf: number[];
}

export interface CachedAnchoredText {
    v: 1;
    /** Engine + traineddata + our assembly code. A mismatch is a clean miss. */
    stamp: string;
    pages: CachedOcrPage[];
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
        if (last && last.y === item.y && last.h === item.height) {
            last.words.push([item.x, item.width, item.start, item.end]);
        } else {
            lines.push({ y: item.y, h: item.height, words: [[item.x, item.width, item.start, item.end]] });
        }
    }
    return lines;
}

/** The inverse of `encodeLines`, restoring the page number each item carries. */
export function decodeLines(lines: CachedLine[], page: number): PdfTextItem[] {
    const items: PdfTextItem[] = [];
    for (const line of lines) {
        for (const [x, width, start, end] of line.words) {
            items.push({ start, end, page, x, y: line.y, width, height: line.h });
        }
    }
    return items;
}

export interface AnchoredTextStore {
    /** The stored value for this key, or null for any miss. Never throws. */
    read(key: string): Promise<CachedAnchoredText | null>;
    /** Record a derived value. A store that cannot write is still a store. */
    write(key: string, pages: CachedOcrPage[]): Promise<void>;
}

/** Narrow a parsed entry, so a truncated or foreign file is a miss, not a crash. */
function isCached(value: unknown): value is CachedAnchoredText {
    if (!isObject(value) || value.v !== 1 || !isString(value.stamp) || !isArray(value.pages)) return false;
    return value.pages.every((page) =>
        isObject(page) && isNumber(page.p) && isString(page.text) && isArray(page.lines) && isArray(page.conf)
        && page.lines.every((line) =>
            isObject(line) && isNumber(line.y) && isNumber(line.h) && isArray(line.words)
            && line.words.every((w) => isArray(w) && w.length === 4 && w.every(isNumber))));
}

/**
 * A file-backed store under `dir` — one file per content key.
 *
 * `dir` is the caller's, out of `Project.dataHome`: this package has no idea
 * which project it is serving. Every failure path is a miss rather than an
 * error, matching the rule extraction already follows for unreadable pages —
 * the cache may make things faster, never make them fail.
 */
export function createAnchoredTextStore(dir: string): AnchoredTextStore {
    const fileFor = (key: string) => path.join(dir, `${key.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);

    return {
        async read(key) {
            try {
                const parsed: unknown = JSON.parse(await fs.promises.readFile(fileFor(key), 'utf8'));
                if (!isCached(parsed) || parsed.stamp !== STAMP) return null;
                return parsed;
            } catch {
                return null;   // absent, unreadable, truncated, or not ours
            }
        },

        async write(key, pages) {
            const entry: CachedAnchoredText = { v: 1, stamp: STAMP, pages };
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
