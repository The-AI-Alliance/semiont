/**
 * Embedded page images from a PDF — the pixels OCR reads.
 *
 * A scanned page holds its characters only as pixels inside an image object,
 * so reading it means getting that image out. We do NOT rasterize: pdf.js
 * decodes the embedded image in its worker (pure JS — JPEG, CCITT and JBIG2
 * decoders all live there) and hands back raw pixel planes, which means no
 * canvas backend and no native dependency. Measured, not assumed — see
 * `.plans/SMELTER-MEDIA-TYPES.md` Resolved decision 10.
 *
 * Two consequences of extracting rather than rendering: we get the scan's own
 * resolution rather than choosing a render DPI (for a real scan that IS the
 * page, so it is what we want), and a page composed of vector overlays or
 * tiled strips yields more than one image, or none we can use. Anything we
 * cannot turn into pixels simply stays unread — never an error.
 */

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { isObject, isNumber } from '@semiont/core';
import { encodePng } from './png-encode';

/** pdf.js image kinds (`ImageKind` in its API). */
const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

/**
 * Normalize a decoded pdf.js image to 8-bit RGB, or null for a kind we do
 * not read. Unknown kinds leave the page unread rather than risk feeding an
 * OCR engine garbled pixels.
 */
function toRgb(image: unknown): { width: number; height: number; rgb: Uint8Array } | null {
    if (!isObject(image)) return null;
    const { width, height, kind, data } = image;
    if (!isNumber(width) || !isNumber(height) || !(data instanceof Uint8Array)) return null;
    if (width <= 0 || height <= 0) return null;

    if (kind === RGB_24BPP) {
        return data.length >= width * height * 3 ? { width, height, rgb: data } : null;
    }

    if (kind === RGBA_32BPP) {
        if (data.length < width * height * 4) return null;
        const rgb = new Uint8Array(width * height * 3);
        for (let i = 0, o = 0; o < rgb.length; i += 4, o += 3) {
            rgb[o] = data[i]!;
            rgb[o + 1] = data[i + 1]!;
            rgb[o + 2] = data[i + 2]!;
        }
        return { width, height, rgb };
    }

    if (kind === GRAYSCALE_1BPP) {
        // Packed bilevel, rows padded to a byte boundary — the shape fax-encoded
        // scans arrive in. A set bit is white, matching pdf.js's own rendering.
        // If a real CCITT scan ever comes out inverted, this is the line to fix;
        // the failure mode is a page that OCRs to nothing, not corrupt output.
        const rowBytes = Math.ceil(width / 8);
        if (data.length < rowBytes * height) return null;
        const rgb = new Uint8Array(width * height * 3);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const bit = data[y * rowBytes + (x >> 3)]! & (0x80 >> (x & 7));
                const value = bit ? 0xFF : 0x00;
                const o = (y * width + x) * 3;
                rgb[o] = value;
                rgb[o + 1] = value;
                rgb[o + 2] = value;
            }
        }
        return { width, height, rgb };
    }

    return null;
}

/** Resolve one image object; pdf.js delivers it asynchronously, so the
 *  callback form is required — the synchronous getter throws. */
function resolveImage(page: pdfjs.PDFPageProxy, ref: string): Promise<unknown> {
    return new Promise((resolve) => {
        try {
            page.objs.get(ref, resolve);
        } catch {
            resolve(null);
        }
    });
}

/**
 * PNG-encoded images for the given pages (all pages when omitted), keyed by
 * 1-indexed page number. Pages with no usable image are absent from the map.
 */
export async function extractPageImages(
    bytes: Uint8Array | Buffer,
    pageNumbers?: number[],
): Promise<Map<number, Buffer[]>> {
    const wanted = pageNumbers ? new Set(pageNumbers) : null;
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
    const byPage = new Map<number, Buffer[]>();

    try {
        const doc = await loadingTask.promise;
        for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
            if (wanted && !wanted.has(pageNum)) continue;
            const page = await doc.getPage(pageNum);
            const ops = await page.getOperatorList();

            const images: Buffer[] = [];
            for (let i = 0; i < ops.fnArray.length; i++) {
                if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
                const ref = ops.argsArray[i]?.[0];
                if (typeof ref !== 'string') continue;
                const rgb = toRgb(await resolveImage(page, ref));
                if (rgb) images.push(encodePng(rgb.width, rgb.height, rgb.rgb));
            }
            if (images.length > 0) byPage.set(pageNum, images);
        }
        return byPage;
    } finally {
        await loadingTask.destroy();
    }
}
