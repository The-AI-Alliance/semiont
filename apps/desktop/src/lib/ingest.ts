import type { ChatSession, IngestResult } from './session';

export interface IngestOptions {
  /** Where the resource bytes live, e.g. `file://docs/spec.md`. */
  storageUri: string;
  /** MIME type of the bytes — `text/markdown`, `image/png`, `application/pdf`, … */
  format: string;
  /** Upload progress as a 0..1 fraction — the browser's real byte-upload progress
   *  (XHR), forwarded as `yield.resource` streams it. */
  onProgress?: (fraction: number) => void;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  csv: 'text/csv',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/**
 * Best-effort MIME type from a filename's extension — for callers without a
 * browser-provided `File.type` (the Node script), or as a fallback when the
 * browser leaves `File.type` empty. Unknown extensions get a generic binary type.
 */
export function mimeTypeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/**
 * Ingest one document (Lane A) — create the resource from the uploaded bytes and
 * embed it, so it's retrievable immediately. Works for any MIME type. The document
 * is created **plain** (no entity types of its own — it's a source document, not an
 * entity instance); marking its references is a separate, on-demand pass the GUI
 * offers on the upload record (`markResource`, driven by the Mark chip).
 *
 * `run()` subscribes the cold UploadObservable once (no double-upload), forwarding
 * the browser's byte progress and resolving the resource id.
 */
export async function ingest(
  session: ChatSession,
  file: File | Buffer,
  name: string,
  opts: IngestOptions,
): Promise<IngestResult> {
  const { resourceId } = await session.client.yield
    .resource({
      name,
      file,
      format: opts.format,
      storageUri: opts.storageUri,
    })
    .run((event) => {
      if (opts.onProgress && event.phase === 'progress' && event.totalBytes > 0) {
        opts.onProgress(event.bytesUploaded / event.totalBytes);
      }
    });

  return { resourceId };
}
