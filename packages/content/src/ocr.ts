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
 * Recognize a batch of PNG images, returning one string per image (empty
 * where nothing legible was found). One worker serves the whole batch —
 * startup is the expensive part, not the pages.
 */
export async function recognizeImages(images: Buffer[]): Promise<string[]> {
    if (images.length === 0) return [];
    // `cacheMethod: 'none'` — the data is already local, so there is nothing to
    // cache and no reason to write a copy into the working directory.
    const worker = await createWorker('eng', undefined, {
        langPath: langPath(),
        cacheMethod: 'none',
    });
    try {
        const results: string[] = [];
        for (const image of images) {
            const { data } = await worker.recognize(image);
            results.push(data.text.trim());
        }
        return results;
    } finally {
        await worker.terminate();
    }
}
