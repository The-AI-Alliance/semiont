/**
 * OCR engine — vendoring and startup.
 *
 * OCR is core (SMELTER-MEDIA-TYPES decision 8), so the engine must run from
 * language data shipped inside the image, never fetched from a CDN at
 * runtime. These tests guard that: the data is on disk as an ordinary
 * dependency, and the worker starts from it. They exercise the real engine —
 * `pdf-ocr.test.ts` stubs it to assert extraction behavior instead.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { recognizeImages } from '../ocr';
import { encodePng } from '../png-encode';

describe('vendored language data', () => {
    it('ships on disk as a dependency, not a runtime download', () => {
        const data = createRequire(import.meta.url)('@tesseract.js-data/eng') as { langPath: string };
        expect(fs.existsSync(path.join(data.langPath, 'eng.traineddata.gz'))).toBe(true);
    });
});

describe('recognizeImages', () => {
    /** A white field with one dark bar — legible or not, the engine must run. */
    const image = (() => {
        const width = 200, height = 80;
        const rgb = new Uint8Array(width * height * 3).fill(0xFF);
        for (let y = 30; y < 50; y++) {
            for (let x = 20; x < 180; x++) rgb.fill(0x10, (y * width + x) * 3, (y * width + x) * 3 + 3);
        }
        return encodePng(width, height, rgb);
    })();

    it('starts a worker from the vendored data and returns one result per image', async () => {
        // Would throw if the language data could not be loaded — which is the
        // point: a missing vendor is a hard failure, not a silent empty read.
        const results = await recognizeImages([image]);
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ text: expect.any(String), words: expect.any(Array) });
        // Whatever the engine read, every word must select itself in the text.
        for (const word of results[0]!.words) {
            expect(results[0]!.text.slice(word.start, word.end)).toBe(word.text);
        }
    }, 30_000);

    it('recognizes nothing without calling the engine', async () => {
        expect(await recognizeImages([])).toEqual([]);
    });

    it('leaves no cached copy in the working directory', async () => {
        // `cacheMethod: 'none'` — before this was set, tesseract.js wrote a
        // 5 MB eng.traineddata into cwd on first use.
        await recognizeImages([image]);
        expect(fs.existsSync(path.join(process.cwd(), 'eng.traineddata'))).toBe(false);
    }, 30_000);
});
