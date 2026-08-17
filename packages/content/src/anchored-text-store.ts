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
 * The seam is `extract()` (PERSIST-ANCHORS D1/P2b): the record is the FINISHED
 * extraction outcome — classification, geometry, provenance, or a named
 * decline — so a hit skips the native parse and the engine both, and every
 * geometry-yielding extraction stores an entry, native documents included.
 * That is what makes the anchored-text endpoint answer for every resource
 * whose extraction yields geometry, and what lets the reconcile planner treat
 * "no entry under the current checksum" as work (P0's third drift class).
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { getShardPath, isObject, isString, isNumber, isArray, type ExtractionOutcome, type Logger, type PdfTextItem } from '@semiont/core';


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
 * The stored record: one extraction OUTCOME for the whole resource
 * (PERSIST-ANCHORS decision D1) — the anchored text with its provenance
 * (`method`, `pdfClass`, `ocrConfidence`, `unreadPages`), or a named decline.
 *
 * Whole-resource on every side, deliberately. The producer's own shape is a
 * per-page map, but that is an artifact of how `ocrPages` iterates, and letting
 * it reach storage would have forced every consumer — the transport, the
 * browser, a headless client — to reassemble pages it never asked to see.
 *
 * The `ocrConfidence` SUMMARY is stored (v2) — this repairs the regression
 * OCR-CONFIDENCE-LOST.md records, where a hit answered with no confidence at
 * all. Per-word confidences remain unstored: the summary is the record's
 * quality provenance; the word list is operator log detail.
 *
 * v1 records (bare `{ text, lines }`, no provenance) read as misses under the
 * v2 prefix; the reconcile planner's third drift class re-derives them.
 */
export type CachedAnchoredText =
    | ({
        v: 2;
        /** Engine + traineddata + our assembly code. A mismatch is a clean miss. */
        stamp: string;
        text: string;
        lines: CachedLine[];
    } & Omit<Extract<ExtractionOutcome, { kind: 'extracted' }>, 'kind' | 'text' | 'items'>)
    | ({
        v: 2;
        stamp: string;
    } & Omit<Extract<ExtractionOutcome, { kind: 'declined' }>, 'kind'>);

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
 *
 * pdf.js joined at P2b, because the seam did: the record is the finished
 * extraction outcome, so it depends on the native parse — classification,
 * text-layer read, table/form shaping — not just the engine. A parser upgrade
 * is a change in the value, and the entry must miss.
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
        + `+pdfjs-${version('pdfjs-dist/package.json')}`
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
    /**
     * The stored map for this key, or null for any miss. Never throws.
     *
     * The key is the **content checksum of the bytes the map derives from**
     * (PERSIST-ANCHORS decision A): a representation is its bytes, so the
     * checksum is its identity, and geometry derived from one revision of the
     * bytes is unreachable by a reader holding a different revision — by
     * construction, not by invalidation. Callers holding some other handle
     * (a resource id) reach the artifact through an index, not by a second
     * key scheme here.
     */
    read(key: string): Promise<ExtractionOutcome | null>;
    /** Record an extraction outcome under the content checksum of its source
     *  bytes. A store that cannot write is still a store. */
    write(key: string, outcome: ExtractionOutcome): Promise<void>;
    /**
     * Every key `read()` would currently HIT — entries under a stale stamp or
     * unreadable files are excluded, exactly as `read()` would exclude them.
     * That equivalence is load-bearing: the reconcile planner treats a listed
     * key as "artifact present" and plans re-derivation for the rest
     * (PERSIST-ANCHORS P0, the third drift class), so a key listed here but
     * missed by `read()` would be a permanent loss the diff can never see —
     * the exact shape of the post-engine-upgrade hole this filter closes.
     * One bulk call per reconcile, never a probe per resource. Never throws.
     */
    list(): Promise<string[]>;
}

/** Narrow a parsed entry, so a truncated or foreign file is a miss, not a crash. */
function isCached(value: unknown): value is CachedAnchoredText {
    if (!isObject(value) || value.v !== 2 || !isString(value.stamp)) return false;
    if (isString(value.declined)) return true;
    if (!isString(value.text) || !isString(value.method) || !isArray(value.lines)) return false;
    return value.lines.every((line) =>
        isObject(line) && isNumber(line.p) && isNumber(line.y) && isNumber(line.h) && isArray(line.words)
        && line.words.every((w) => isArray(w) && w.length === 4 && w.every(isNumber)));
}

/** A key that could not have come from a checksum (or a legacy hex handle) is
 *  refused outright rather than sanitized: a silently stripped key could share
 *  a file with a different entry. Rejection replaces the old strip
 *  (PERSIST-ANCHORS, *Smaller things*). */
const VALID_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * A file-backed store under `dir` — one file per content key, sharded as
 * `{ab}/{cd}/{key}.json` via the same `getShardPath` the event log uses
 * (PERSIST-ANCHORS decision E). Same convention, separate tree: `.semiont/`
 * is the KB's committed system of record; everything here is derived,
 * reclaimable, and never a source of truth.
 *
 * `dir` is the caller's, out of `Project.anchoredTextDir`: this package has no idea
 * which project it is serving. Every failure path is a miss rather than an
 * error, matching the rule extraction already follows for unreadable pages —
 * the cache may make things faster, never make them fail.
 */
export function createAnchoredTextStore(dir: string, logger?: Logger): AnchoredTextStore {
    const fileFor = (key: string): string | null => {
        if (!VALID_KEY.test(key)) return null;
        const [ab, cd] = getShardPath(key);
        return path.join(dir, ab, cd, `${key}.json`);
    };

    return {
        async read(key) {
            let hit: CachedAnchoredText | null = null;
            try {
                const file = fileFor(key);
                if (file === null) throw new Error('invalid key');   // refused → a miss like any other
                const parsed: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'));
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
                ...(hit ? ('declined' in hit ? { declined: hit.declined } : { lines: hit.lines.length }) : {}),
            });
            if (!hit) return null;
            // `kind` is not persisted — the branch is implied by the record's
            // own shape, and re-added here so readers get the discriminated
            // wire union (WIRE-UNION-DISCRIMINANTS P5c).
            if ('declined' in hit) return { kind: 'declined', declined: hit.declined };
            const { v: _v, stamp: _stamp, lines, text, ...provenance } = hit;
            return { kind: 'extracted', text, items: decodeLines(lines), ...provenance };
        },

        async write(key, outcome) {
            const target = fileFor(key);
            if (target === null) {
                logger?.debug('Anchored-text cache: refusing invalid key', { key });
                return;   // a store that cannot write is still a store
            }
            // Key order (`v`, `stamp`, first) is load-bearing: `list()` below
            // reads only a prefix of each file and matches the stamp there.
            const entry: CachedAnchoredText = outcome.kind === 'declined'
                ? { v: 2, stamp: STAMP, declined: outcome.declined }
                : (() => {
                    // `kind` is deliberately destructured OUT: persisting it
                    // would store a byte the branch already implies, and a
                    // stored-shape change here would outrun the release-derived
                    // STAMP (WIRE-UNION-DISCRIMINANTS P5c).
                    const { kind: _kind, text, items, ...provenance } = outcome;
                    return { v: 2, stamp: STAMP, text, lines: encodeLines(items), ...provenance };
                })();
            // Write-then-rename: a reader never observes a half-written entry,
            // and two writers racing on the same key both produce the same bytes.
            const temp = `${target}.${process.pid}.tmp`;
            try {
                await fs.promises.mkdir(path.dirname(target), { recursive: true });
                await fs.promises.writeFile(temp, JSON.stringify(entry), 'utf8');
                await fs.promises.rename(temp, target);
            } catch {
                await fs.promises.rm(temp, { force: true }).catch(() => {});
            }
        },

        async list() {
            // Would-hit keys only (see the interface doc). The stamp check
            // reads a bounded prefix rather than parsing whole entries — an
            // artifact is ~32 KB per scanned page and this runs over every
            // entry at every reconcile. Sound because `write()` above puts
            // `v` and `stamp` first, so the current stamp appears within the
            // first bytes of every entry this store has ever written; a file
            // whose prefix doesn't match is either stale or not ours, and
            // both are misses for `read()` too. Keys round-trip through
            // filenames unchanged because every real key is hex — the same
            // fact that makes `fileFor`'s guard a no-op for them.
            const prefix = JSON.stringify({ v: 2, stamp: STAMP }).slice(0, -1) + ',';
            let rootNames: string[];
            try {
                rootNames = await fs.promises.readdir(dir);
            } catch {
                return [];   // no directory yet: nothing has been written
            }

            // One-generation sweep (PERSIST-ANCHORS P1): a `.json` at the root
            // is a pre-P1 entry — flat layout, resource-id key, a dead scheme.
            // The rebuild path (P0's third drift class) re-derives anything
            // still needed, which is what makes this delete safe; leaving a
            // generation behind is how the store's size becomes unexplainable.
            // Done here because list() is the one bulk call every reconcile
            // already makes, so the sweep runs exactly when the planner is
            // about to notice what is missing. Best-effort, never throws.
            let swept = 0;
            for (const name of rootNames) {
                if (!name.endsWith('.json')) continue;
                await fs.promises.rm(path.join(dir, name), { force: true }).then(() => { swept += 1; }, () => {});
            }
            if (swept > 0) logger?.info('Anchored-text cache: swept pre-P1 flat entries', { swept });

            const keys: string[] = [];
            let sweptInterim = 0;
            for (const ab of rootNames) {
                if (!/^[0-9a-f]{2}$/.test(ab)) continue;
                let cdNames: string[];
                try {
                    cdNames = await fs.promises.readdir(path.join(dir, ab));
                } catch {
                    continue;
                }
                for (const cd of cdNames) {
                    if (!/^[0-9a-f]{2}$/.test(cd)) continue;
                    let names: string[];
                    try {
                        names = await fs.promises.readdir(path.join(dir, ab, cd));
                    } catch {
                        continue;
                    }
                    for (const name of names) {
                        if (!name.endsWith('.json')) continue;
                        // Interim-generation sweep (PERSIST-ANCHORS P1b): a
                        // 32-hex basename is a resource-id key — writes that
                        // landed sharded between P1a's rekey and P1b's
                        // call-site switch. Checksums are 64-hex (SHA-256),
                        // so the two generations are disjoint by length.
                        // Reaped here for the same reason the flat sweep
                        // lives here: one bulk call per reconcile, and never
                        // a third scheme lingering silently.
                        const base = name.slice(0, -'.json'.length);
                        if (/^[0-9a-f]{32}$/.test(base)) {
                            await fs.promises.rm(path.join(dir, ab, cd, name), { force: true }).then(() => { sweptInterim += 1; }, () => {});
                            continue;
                        }
                        let handle: fs.promises.FileHandle | null = null;
                        try {
                            handle = await fs.promises.open(path.join(dir, ab, cd, name), 'r');
                            const buf = Buffer.alloc(prefix.length);
                            const { bytesRead } = await handle.read(buf, 0, prefix.length, 0);
                            if (bytesRead === prefix.length && buf.toString('utf8') === prefix) {
                                keys.push(base);
                            }
                        } catch {
                            // unreadable is a miss, matching read()
                        } finally {
                            await handle?.close().catch(() => {});
                        }
                    }
                }
            }
            if (sweptInterim > 0) logger?.info('Anchored-text cache: swept interim resource-id entries', { swept: sweptInterim });
            return keys;
        },
    };
}
