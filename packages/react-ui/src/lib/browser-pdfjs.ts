/**
 * Browser PDF.js utilities
 *
 * Uses native browser PDF.js when available, falls back to CDN.
 * Zero npm dependencies - no webpack bundling issues.
 */

// Type definitions for PDF.js API
export interface PDFDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PDFPageProxy>;
}

export interface PDFPageProxy {
  getViewport(params: { scale: number; rotation?: number }): PDFViewport;
  render(params: PDFRenderParams): PDFRenderTask;
  getTextContent(): Promise<TextContent>;
}

export interface PDFViewport {
  width: number;
  height: number;
  scale: number;
  rotation: number;
}

export interface PDFRenderParams {
  canvasContext: CanvasRenderingContext2D;
  viewport: PDFViewport;
}

export interface PDFRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export interface PDFLib {
  getDocument(params: { data: ArrayBuffer } | { url: string }): PDFLoadingTask;
  GlobalWorkerOptions: {
    workerSrc: string;
  };
  version: string;
}

export interface PDFLoadingTask {
  promise: Promise<PDFDocumentProxy>;
  destroy(): void;
}

/**
 * Text content types (for Phase 2)
 */
export interface TextItem {
  str: string;
  dir: string;
  transform: number[]; // [scaleX, skewX, skewY, scaleY, x, y]
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

export interface TextContent {
  items: TextItem[];
  styles: Record<string, any>;
}

/**
 * Ensure PDF.js is available, loading from local public folder if needed
 */
export async function ensurePdfJs(): Promise<PDFLib> {
  // Check if already available (browser native or already loaded)
  if (typeof window !== 'undefined' && (window as any).pdfjsLib) {
    return (window as any).pdfjsLib as PDFLib;
  }

  // Load from local public folder (staged during build)
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/pdfjs/pdf.min.mjs';
    script.type = 'module';

    script.onload = () => {
      const pdfjsLib = (window as any).pdfjsLib as PDFLib;

      if (!pdfjsLib) {
        reject(new Error('PDF.js loaded but pdfjsLib not available'));
        return;
      }

      // Configure worker (also served from local public folder)
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

      resolve(pdfjsLib);
    };

    script.onerror = () => {
      reject(new Error('Failed to load PDF.js from /pdfjs/pdf.min.mjs'));
    };

    document.head.appendChild(script);
  });
}

/**
 * Load PDF document from URL or ArrayBuffer
 *
 * When given a URL string, fetches the PDF as ArrayBuffer with credentials
 * to ensure authentication cookies are included in the request.
 */
export async function loadPdfDocument(
  source: string | ArrayBuffer
): Promise<PDFDocumentProxy> {
  const pdfjsLib = await ensurePdfJs();

  if (typeof source === 'string') {
    // Fetch as ArrayBuffer first to include authentication cookies
    const response = await fetch(source, {
      credentials: 'include',
      headers: {
        'Accept': 'application/pdf',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    return loadingTask.promise;
  } else {
    const loadingTask = pdfjsLib.getDocument({ data: source });
    return loadingTask.promise;
  }
}

/**
 * Render PDF page to canvas and return as data URL
 */
export async function renderPdfPageToDataUrl(
  page: PDFPageProxy,
  scale = 1.0
): Promise<{ dataUrl: string; width: number; height: number }> {
  const viewport = page.getViewport({ scale });

  // Create canvas
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to get 2D context');
  }

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  // Render PDF page to canvas
  const renderTask = page.render({
    canvasContext: context,
    viewport: viewport
  });

  await renderTask.promise;

  // Convert to data URL
  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: viewport.width,
    height: viewport.height
  };
}

/**
 * Render PDF page with text content extraction (Phase 2)
 *
 * This function extracts text in parallel with rendering for future
 * text layer support. Currently the text content is available but not used.
 */
export async function renderPdfPageWithText(
  page: PDFPageProxy,
  scale = 1.0
): Promise<{
  dataUrl: string;
  width: number;
  height: number;
  textContent: TextContent;
}> {
  const viewport = page.getViewport({ scale });

  // Create canvas for rendering
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Failed to get 2D context');
  }

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  // Render PDF page to canvas
  const renderTask = page.render({
    canvasContext: context,
    viewport: viewport
  });

  // Extract text content in parallel (for future text layer support)
  const [, textContent] = await Promise.all([
    renderTask.promise,
    page.getTextContent()
  ]);

  // Convert to data URL
  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: viewport.width,
    height: viewport.height,
    textContent
  };
}
