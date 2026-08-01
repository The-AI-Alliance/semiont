/**
 * OCR — reading text out of page pixels (tesseract.js).
 *
 * Runs inline, on the caller's thread of control, deliberately: the Smelter's
 * lanes are per-resource and concurrent (`groupBy` + `mergeMap`), so a slow
 * page delays only its own resource, never the fast text resources it shares
 * a worker with. Extraction stays ephemeral — nothing is cached, and a
 * rebuild re-reads the pixels (SMELTER-MEDIA-TYPES Design §3/§5).
 *
 * Deterministic for a pinned engine: the same bytes yield the same text, so
 * re-running costs time and nothing else.
 */

import { createRequire } from 'node:module';
import { createWorker } from 'tesseract.js';
import { isObject, isString } from '@semiont/core';

/**
 * The vendored language data — `@tesseract.js-data/eng` ships the same
 * `eng.traineddata.gz` tesseract.js would otherwise fetch from a CDN, and
 * exports the directory holding it.
 *
 * OCR is core (SMELTER-MEDIA-TYPES decision 8), so it must never reach the
 * network at runtime: an air-gapped worker has to be able to read a scan, and
 * a CDN outage must not silently turn scanned documents unreadable. Because
 * this is an ordinary dependency, `npm install` vendors it into the smelter
 * and worker images — no Dockerfile fetch step, and the lockfile pins it.
 *
 * Resolved lazily so importing this module has no side effects.
 */
let cachedLangPath: string | undefined;
function langPath(): string {
    if (cachedLangPath) return cachedLangPath;
    const data: unknown = createRequire(import.meta.url)('@tesseract.js-data/eng');
    if (!isObject(data) || !isString(data.langPath)) {
        throw new Error(
            'Vendored OCR language data is missing or malformed: @tesseract.js-data/eng did not export a langPath',
        );
    }
    cachedLangPath = data.langPath;
    return cachedLangPath;
}

/**
 * The slice of tesseract's recognition tree this module reads. Declared
 * structurally rather than importing `Tesseract.Block`, so tests can build a
 * tree without satisfying a dozen fields nothing here looks at; a real
 * `Block[]` still satisfies it.
 */
export interface OcrBbox { x0: number; y0: number; x1: number; y1: number }
export interface OcrBlock {
    paragraphs: { lines: { words: { text: string; confidence: number; bbox: OcrBbox }[] }[] }[];
}

/** A recognized word, with the range it occupies in the assembled page text. */
export interface OcrWord {
    text: string;
    /** Offsets into `OcrPage.text` — `text.slice(start, end) === word.text`. */
    start: number;
    end: number;
    /** Image pixel space, top-left origin — mapped to PDF points downstream. */
    bbox: OcrBbox;
    confidence: number;
}

export interface OcrPage {
    text: string;
    words: OcrWord[];
}

/**
 * Assemble a page's text from its recognition tree, recording where each word
 * lands as it is written.
 *
 * The text is built here rather than taken from tesseract's own `data.text`
 * precisely so the offsets are exact **by construction** — deriving offsets by
 * searching for words in a separately-produced string is where this kind of
 * code goes wrong. Words join with a space, lines with a newline, paragraphs
 * with a blank line.
 */
export function assemblePage(blocks: OcrBlock[] | null): OcrPage {
    let text = '';
    const words: OcrWord[] = [];

    for (const block of blocks ?? []) {
        for (const paragraph of block.paragraphs ?? []) {
            for (const line of paragraph.lines ?? []) {
                let wroteWord = false;
                for (const word of line.words ?? []) {
                    const value = word.text.trim();
                    if (!value) continue;              // an empty box is not a word
                    if (wroteWord) text += ' ';
                    const start = text.length;
                    text += value;
                    words.push({
                        text: value,
                        start,
                        end: text.length,
                        bbox: word.bbox,
                        confidence: word.confidence,
                    });
                    wroteWord = true;
                }
                if (wroteWord) text += '\n';
            }
            text += '\n';
        }
    }

    // Only trailing separators are removed, so no recorded offset moves.
    return { text: text.trimEnd(), words };
}

/**
 * Recognize a batch of PNG images, returning one result per image (empty
 * where nothing legible was found). One worker serves the whole batch —
 * startup is the expensive part, not the pages.
 */
export async function recognizeImages(images: Buffer[]): Promise<OcrPage[]> {
    if (images.length === 0) return [];
    // `cacheMethod: 'none'` — the data is already local, so there is nothing to
    // cache and no reason to write a copy into the working directory.
    const worker = await createWorker('eng', undefined, {
        langPath: langPath(),
        cacheMethod: 'none',
    });
    try {
        const results: OcrPage[] = [];
        for (const image of images) {
            // `blocks: true` is what carries the per-word geometry; without it
            // tesseract returns text only and `data.blocks` is null.
            const { data } = await worker.recognize(image, {}, { blocks: true, text: false });
            results.push(assemblePage(data.blocks));
        }
        return results;
    } finally {
        await worker.terminate();
    }
}
