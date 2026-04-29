/**
 * HttpContentTransport — binary I/O over HTTP.
 *
 * Phase 1 of TRANSPORT-ABSTRACTION. Narrow by design because binary has
 * different backpressure and streaming characteristics than typed command
 * payloads. Uses the HttpTransport's underlying ky instance + token, so
 * retries, logging, and auth behave identically to the rest of the wire.
 *
 * Two `putBinary` paths live side by side:
 *   - **No `onProgress`** — the original `ky.post(...)` path. Keeps
 *     retry-with-refresh, beforeError → APIError, observability spans
 *     intact. Workers and the CLI hit this; they don't need byte
 *     progress.
 *   - **With `onProgress`** — an XHR path, hand-rolled because `ky`
 *     wraps `fetch` which can't observe upload byte-progress today
 *     (`Request({ duplex: 'half' })` is the long-term direction; not yet
 *     widely available across the webviews this codepath needs to run
 *     in). The XHR path threads auth + traceparent headers, emits
 *     `onProgress` from `xhr.upload.onprogress`, supports cancellation
 *     via the `signal` option, and routes failures onto the same
 *     `transport.errors$` stream the ky path uses.
 *
 * v1 limitation: the XHR path does NOT auto-refresh on 401. Mitigation:
 * the session's proactive refresh fires before token expiry, so an
 * upload that *starts* with a fresh token usually completes. An upload
 * spanning the narrow window between expiry and proactive-refresh would
 * fail; the existing `errors$` → modal path surfaces it as session-
 * expired. If retry-with-refresh on the upload path becomes a real
 * complaint, wire a manual retry loop here that reads `token$` afresh.
 */

import type { AccessToken, ContentFormat, ResourceId, PutBinaryOptions } from '@semiont/core';
import { busLog } from '@semiont/core';
import { SpanKind, getActiveTraceparent, withSpan } from '@semiont/observability';
import type { HttpTransport } from './http-transport';
import { APIError } from './http-transport';
import type { IContentTransport, PutBinaryRequest } from '@semiont/core';

export class HttpContentTransport implements IContentTransport {
  constructor(private readonly transport: HttpTransport) {}

  async putBinary(
    request: PutBinaryRequest,
    options?: PutBinaryOptions,
  ): Promise<{ resourceId: ResourceId }> {
    const sizeBytes = request.file instanceof File ? request.file.size : request.file.length;
    busLog('PUT', 'content', {
      name: request.name,
      format: request.format,
      storageUri: request.storageUri,
      sizeBytes,
    });
    return withSpan(
      'content.put',
      async () => {
        const formData = buildFormData(request);
        const headers = this.requestHeaders(options?.auth);

        // Branch on `onProgress` presence. The ky path is the well-trodden
        // default; the XHR path lights up when a caller wants byte progress
        // or cancellation via `signal`.
        if (options?.onProgress || options?.signal) {
          return uploadViaXhr({
            url: `${this.transport.baseUrl}/resources`,
            formData,
            headers,
            onProgress: options.onProgress,
            signal: options.signal,
            onApiError: (err) => this.transport.pushError(err),
          });
        }

        const result = await this.transport.rawHttp
          .post(`${this.transport.baseUrl}/resources`, {
            body: formData,
            headers,
          })
          .json<{ resourceId: string }>();

        return { resourceId: result.resourceId as ResourceId };
      },
      {
        kind: SpanKind.CLIENT,
        attrs: {
          'content.format': request.format,
          'content.size_bytes': sizeBytes,
        },
      },
    );
  }

  async getBinary(
    resourceId: ResourceId,
    options?: { accept?: ContentFormat | string; auth?: AccessToken },
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    busLog('GET', 'content', { resourceId, accept: options?.accept });
    return withSpan(
      'content.get',
      async () => {
        const response = await this.transport.rawHttp.get(`${this.transport.baseUrl}/resources/${resourceId}`, {
          headers: {
            Accept: options?.accept ?? 'text/plain',
            ...this.requestHeaders(options?.auth),
          },
        });
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const data = await response.arrayBuffer();
        return { data, contentType };
      },
      { kind: SpanKind.CLIENT, attrs: { 'resource.id': resourceId as unknown as string } },
    );
  }

  async getBinaryStream(
    resourceId: ResourceId,
    options?: { accept?: ContentFormat | string; auth?: AccessToken },
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
    busLog('GET', 'content', { resourceId, accept: options?.accept, stream: true });
    return withSpan(
      'content.get',
      async () => {
        const response = await this.transport.rawHttp.get(`${this.transport.baseUrl}/resources/${resourceId}`, {
          headers: {
            Accept: options?.accept ?? 'text/plain',
            ...this.requestHeaders(options?.auth),
          },
        });
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        if (!response.body) {
          throw new Error('Response body is null - cannot create stream');
        }
        return { stream: response.body, contentType };
      },
      {
        kind: SpanKind.CLIENT,
        attrs: { 'resource.id': resourceId as unknown as string, 'content.stream': true },
      },
    );
  }

  dispose(): void {
    // HttpContentTransport has no resources of its own; HttpTransport owns
    // the ky instance and token subject. No-op is correct here.
  }

  /** Auth header + W3C trace propagation for the active span. */
  private requestHeaders(override?: AccessToken): Record<string, string> {
    const token = override ?? this.transport.getToken();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const trace = getActiveTraceparent();
    if (trace) {
      headers['traceparent'] = trace.traceparent;
      if (trace.tracestate) headers['tracestate'] = trace.tracestate;
    }
    return headers;
  }
}

function buildFormData(request: PutBinaryRequest): FormData {
  const formData = new FormData();
  formData.append('name', request.name);
  formData.append('format', request.format);
  formData.append('storageUri', request.storageUri);

  if (request.file instanceof File) {
    formData.append('file', request.file);
  } else if (Buffer.isBuffer(request.file)) {
    const blob = new Blob([new Uint8Array(request.file)], { type: request.format });
    formData.append('file', blob, request.name);
  } else {
    throw new Error('file must be a File or Buffer');
  }

  if (request.entityTypes && request.entityTypes.length > 0) {
    formData.append('entityTypes', JSON.stringify(request.entityTypes));
  }
  if (request.language) formData.append('language', request.language);
  if (request.creationMethod) formData.append('creationMethod', String(request.creationMethod));
  if (request.sourceAnnotationId) formData.append('sourceAnnotationId', String(request.sourceAnnotationId));
  if (request.sourceResourceId) formData.append('sourceResourceId', String(request.sourceResourceId));
  if (request.generationPrompt) formData.append('generationPrompt', request.generationPrompt);
  if (request.generator) formData.append('generator', JSON.stringify(request.generator));
  if (request.isDraft !== undefined) formData.append('isDraft', String(request.isDraft));

  return formData;
}

interface XhrUploadOptions {
  url: string;
  formData: FormData;
  headers: Record<string, string>;
  onProgress?: (event: { bytesUploaded: number; totalBytes: number }) => void;
  signal?: AbortSignal;
  onApiError: (error: APIError) => void;
}

/**
 * XHR-based POST that exposes `xhr.upload.onprogress` byte counts and
 * supports cancellation via `AbortSignal`. Mirrors the ky path's error
 * shape: 4xx/5xx and network-level failures both surface as `APIError`,
 * and every error is routed onto `transport.errors$` before the promise
 * rejects.
 */
function uploadViaXhr(opts: XhrUploadOptions): Promise<{ resourceId: ResourceId }> {
  const { url, formData, headers, onProgress, signal, onApiError } = opts;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    if (signal?.aborted) {
      const err = new APIError('Upload aborted', 0, 'aborted');
      onApiError(err);
      reject(err);
      return;
    }

    xhr.open('POST', url);
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }

    if (onProgress) {
      xhr.upload.onprogress = (e: ProgressEvent) => {
        // `lengthComputable` is true when Content-Length is known. For
        // FormData posts the browser computes it, so this is true in
        // practice; the false branch handles the rare chunked-encoding
        // / gzip-while-uploading case.
        const totalBytes = e.lengthComputable ? e.total : 0;
        onProgress({ bytesUploaded: e.loaded, totalBytes });
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as { resourceId: string };
          resolve({ resourceId: body.resourceId as ResourceId });
        } catch (parseErr) {
          const err = new APIError(
            `Upload succeeded but response was not valid JSON: ${(parseErr as Error).message}`,
            xhr.status,
            xhr.statusText,
            xhr.responseText,
          );
          onApiError(err);
          reject(err);
        }
        return;
      }
      let body: unknown = xhr.responseText;
      try { body = JSON.parse(xhr.responseText); } catch { /* keep as text */ }
      const message = (body && typeof body === 'object' && 'message' in body && typeof (body as { message: unknown }).message === 'string')
        ? (body as { message: string }).message
        : `HTTP ${xhr.status}: ${xhr.statusText}`;
      const err = new APIError(message, xhr.status, xhr.statusText, body);
      onApiError(err);
      reject(err);
    };

    xhr.onerror = () => {
      // Network-level failure (DNS, TCP reset, CORS). XHR doesn't give
      // us a useful status here; classify as `unavailable` via 0 status
      // mapping in classifyApiCode.
      const err = new APIError('Network error during upload', 0, 'network-error');
      onApiError(err);
      reject(err);
    };

    xhr.ontimeout = () => {
      const err = new APIError('Upload timed out', 0, 'timeout');
      onApiError(err);
      reject(err);
    };

    xhr.onabort = () => {
      // Caller-initiated abort via `signal`. Emit a single APIError so the
      // shape matches the other failure paths; consumers can disambiguate
      // via `signal.aborted` if they need to.
      const err = new APIError('Upload aborted', 0, 'aborted');
      onApiError(err);
      reject(err);
    };

    if (signal) {
      const onAbort = () => xhr.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      // No teardown for the listener — once xhr fires onabort/onerror/onload
      // the signal is no longer relevant; the listener is GC'd with the xhr.
    }

    xhr.send(formData);
  });
}
