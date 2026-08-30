/**
 * Embedded page images from a PDF — the pixels OCR reads.
 *
 * A scanned page holds its characters only as pixels inside an image object,
 * so reading it means getting that image out. We do NOT rasterize: pdf.js
 * decodes the embedded image in its worker (pure JS — JPEG, CCITT and JBIG2
 * decoders all live there) and hands back raw pixel planes, which means no
 * canvas gateway and no native dependency. Measured, not assumed — see
 * `.plans/SMELTER-MEDIA-TYPES.md` Resolved decision 10.
 *
 * Two consequences of extracting rather than rendering: we get the scan's own
 * resolution rather than choosing a render DPI (for a real scan that IS the
 * page, so it is what we want), and a page composed of vector overlays or
 * tiled strips yields more than one image, or none we can use. Anything we
 * cannot turn into pixels simply stays unread — never an error.
 */

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { STANDARD_FONT_DATA_URL } from './pdfjs-assets';
import { isObject, isNumber, isString, isArray } from '@semiont/core';
import { encodePng } from './png-encode';

/** pdf.js image kinds (`ImageKind` in its API). */
const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

const IDENTITY: readonly number[] = [1, 0, 0, 1, 0, 0];

/**
 * Largest image this will read, in pixels.
 *
 * Sizing this needs the WHOLE allocation chain, not just the decoded raster —
 * reading one image can hold several copies at once:
 *
 *   pdf.js decoded samples   4 bytes/px worst case (RGBA; RGB is 3)
 *   + `toRgb` conversion     3 bytes/px (RGBA and 1-bit both allocate a copy;
 *                              plain RGB is passed through, no copy)
 *   + `encodePng` scanlines  3 bytes/px (`raw`, plus a filter byte per row)
 *   + deflate output         smaller, but live alongside the above
 *   ────────────────────────────────────────────────────────────────────
 *   ≈ 10 bytes/px transient peak for a single image
 *
 * So the budget below implies roughly half a gigabyte of transient peak for
 * one pathological page — the number to size a worker against. Stating three
 * bytes per pixel here (as an earlier revision did) understated it by ~3× and
 * gave a false sense of safety.
 *
 * Chosen to admit the legitimate large cases with headroom: US Letter at
 * 600dpi is ~34 MP and A0 at 300dpi is ~35 MP, against an ordinary US Letter
 * at 300dpi of ~8 MP.
 *
 * A starting point, not a measured optimum: revisit against a real scanned
 * corpus (SMELTER-MEDIA-TYPES, live-testing follow-up). Lowering the peak
 * itself means removing copies from the chain — passing the decoded samples
 * straight to the encoder — which is a refactor, not a smaller constant.
 */
export const MAX_IMAGE_PIXELS = 48_000_000;

/** Worst-case bytes held per pixel while reading one image — the chain above.
 *  Exported so the budget's real cost is asserted rather than assumed. */
export const PEAK_BYTES_PER_PIXEL = 10;

/** Whether an image's dimensions are sane and inside the budget. Exported
 *  because the threshold is a judgement, and judgements deserve tests. */
export function withinPixelBudget(width: number, height: number): boolean {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    if (width <= 0 || height <= 0) return false;
    return width * height <= MAX_IMAGE_PIXELS;
}

/** An image painted on a page, with the matrix that placed it. */
export interface PlacedImage {
    ref: string;
    /** Natural pixel dimensions, as reported by the paint operator itself. */
    width: number;
    height: number;
    /** Maps the image's unit square onto the page, in PDF points. */
    ctm: number[];
}

/**
 * Walk an operator list and report every painted image with the matrix in
 * effect when it was painted.
 *
 * Exported for its own tests: the composition ORDER cannot be checked with a
 * generated fixture, because pdf-lib emits a single combined matrix per image
 * and identity × M equals M × identity. It is checked directly instead, with
 * two non-identity transforms.
 *
 * Order convention: `ctm = Util.transform(ctm, m)` puts each new matrix on the
 * right, so it applies to a point FIRST and the enclosing matrices after —
 * which is what PDF nesting means. `save`/`restore` bracket the stack.
 */
export function findPlacedImages(fnArray: number[], argsArray: unknown[][]): PlacedImage[] {
    const placed: PlacedImage[] = [];
    const stack: number[][] = [];
    let ctm: number[] = [...IDENTITY];

    for (let i = 0; i < fnArray.length; i++) {
        const op = fnArray[i];
        const args = argsArray[i];
        if (op === pdfjs.OPS.save) {
            stack.push([...ctm]);
        } else if (op === pdfjs.OPS.restore) {
            ctm = stack.pop() ?? [...IDENTITY];
        } else if (op === pdfjs.OPS.transform) {
            if (isArray(args) && args.length >= 6 && args.every(isNumber)) {
                ctm = pdfjs.Util.transform(ctm, args as number[]);
            }
        } else if (op === pdfjs.OPS.paintImageXObject) {
            const ref = args?.[0];
            const width = args?.[1];
            const height = args?.[2];
            if (isString(ref) && isNumber(width) && isNumber(height)) {
                placed.push({ ref, width, height, ctm: [...ctm] });
            }
        }
    }
    return placed;
}

/**
 * The decoded samples, whichever byte view pdf.js chose.
 *
 * `/FlateDecode` images arrive as a `Uint8Array`; `/DCTDecode` (JPEG) — what
 * essentially every real scanned PDF uses — arrives as a `Uint8ClampedArray`,
 * which is NOT an instance of `Uint8Array`. Testing only for the latter
 * discarded every real scan while accepting every fixture in this repo, all
 * of which are Flate. Both index bytes identically, so both are read; the
 * clamped view is re-wrapped without copying its 12 MB buffer.
 */
function asBytes(data: unknown): Uint8Array | null {
    if (data instanceof Uint8Array) return data;
    if (data instanceof Uint8ClampedArray) return new Uint8Array(data.buffer, data.byteOffset, data.length);
    return null;
}

/**
 * Normalize a decoded pdf.js image to 8-bit RGB, or null for a kind we do
 * not read. Unknown kinds leave the page unread rather than risk feeding an
 * OCR engine garbled pixels.
 */
export function toRgb(image: unknown): { width: number; height: number; rgb: Uint8Array } | null {
    if (!isObject(image)) return null;
    const { width, height, kind } = image;
    const data = asBytes(image.data);
    if (!isNumber(width) || !isNumber(height) || !data) return null;
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

/**
 * How long to wait for pdf.js to deliver one image before giving up on the
 * page. Generous: this is not a performance budget but a liveness backstop —
 * see `resolveImage`.
 */
const IMAGE_RESOLVE_TIMEOUT_MS = 30_000;

/**
 * Resolve one image object; pdf.js delivers it asynchronously, so the callback
 * form is required — the synchronous getter throws.
 *
 * Two scopes, and asking the wrong one never answers. An image used by a single
 * page lives in `page.objs` as `img_p0_1`; an image used by MORE than one page
 * — a letterhead, a watermark, a scan pipeline that dedupes identical page
 * rasters — is promoted to pdf.js's global scope, renamed `g_d1_img_p1_1`, and
 * lives in `page.commonObjs`. `objs.get` on a global ref simply registers a
 * callback that is never invoked.
 *
 * The timeout is the second half, and it is about liveness rather than speed:
 * the smelter and the detection worker both `await` this, and a worker will not
 * claim another job while one is active — so a promise that never settles wedges
 * that worker permanently, on one bad document. Timing out yields `null`, which
 * leaves the page unread and reported, the same as an unreadable image kind.
 */
function resolveImage(page: pdfjs.PDFPageProxy, ref: string): Promise<unknown> {
    // pdf.js marks globally-scoped objects with a `g_` prefix.
    const scope = ref.startsWith('g_') ? page.commonObjs : page.objs;
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), IMAGE_RESOLVE_TIMEOUT_MS);
        const settle = (value: unknown) => {
            clearTimeout(timer);
            resolve(value);
        };
        try {
            scope.get(ref, settle);
        } catch {
            settle(null);
        }
    });
}

/** A page image ready for OCR, with everything needed to map results back. */
export interface PageImage {
    png: Buffer;
    /** Pixel dimensions of the decoded raster (may differ from the paint
     *  operator's declared size if the image was resampled). */
    width: number;
    height: number;
    /** Maps the image's unit square onto the page, in PDF points. */
    ctm: number[];
}

/**
 * PNG-encoded images for the given pages (all pages when omitted), keyed by
 * 1-indexed page number, each with the matrix that placed it. Pages with no
 * usable image are absent from the map.
 */
export async function extractPageImages(
    bytes: Uint8Array | Buffer,
    pageNumbers?: number[],
): Promise<Map<number, PageImage[]>> {
    const wanted = pageNumbers ? new Set(pageNumbers) : null;
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONT_DATA_URL });
    const byPage = new Map<number, PageImage[]>();

    try {
        const doc = await loadingTask.promise;
        for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
            if (wanted && !wanted.has(pageNum)) continue;
            const page = await doc.getPage(pageNum);
            const ops = await page.getOperatorList();

            const images: PageImage[] = [];
            for (const placement of findPlacedImages(ops.fnArray, ops.argsArray)) {
                // Checked from the paint operator's own dimensions, BEFORE the
                // image is resolved — refusing after decoding would already
                // have paid the allocation this guards against.
                if (!withinPixelBudget(placement.width, placement.height)) continue;
                const rgb = toRgb(await resolveImage(page, placement.ref));
                if (!rgb) continue;
                images.push({
                    png: encodePng(rgb.width, rgb.height, rgb.rgb),
                    width: rgb.width,
                    height: rgb.height,
                    ctm: placement.ctm,
                });
            }
            if (images.length > 0) byPage.set(pageNum, images);
        }
        return byPage;
    } finally {
        await loadingTask.destroy();
    }
}
