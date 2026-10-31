/**
 * HttpContentTransport — binary I/O over HTTP.
 *
 * Narrow by design, because binary has different backpressure and streaming
 * characteristics than typed command payloads. It uses the HttpTransport's
 * ky instance and token, so a read or an upload is authenticated, renewed,
 * logged and reported as any other request of the transport.
 *
 * An upload (`putBinary`) reports its progress and can be cancelled wherever
 * it runs. How it is sent depends on what the runtime offers:
 *
 *   - **A browser page**, when its caller asks for progress or gives a
 *     `signal`: through `XMLHttpRequest`, whose `upload.onprogress` is the
 *     only count of bytes sent every browser has. `fetch` carries a streamed
 *     request body in some browsers and not others, and in none over
 *     HTTP/1.1. An upload whose credential is refused is sent once more with
 *     the transport's renewed token, as one through ky is; its progress is
 *     never reported as less than it was before.
 *   - **Anywhere else** (Node, as a worker, a script or the CLI runs it),
 *     and a browser page whose caller asked for neither: through ky. Asked
 *     for progress, the body is handed to the connection a piece at a time
 *     and each piece is reported once the connection has asked for it; a
 *     `signal` is ky's own, and closes the connection. The runtime must
 *     carry a streamed request body, as Node does.
 *
 * Cancelled, an upload rejects with its `signal`'s reason, as an abandoned
 * bus request does, and nothing is put on `transport.errors$`: that stream
 * reports what the gateway did, and this is the caller's own doing.
 *
 * An upload has no deadline (`httpRequestTimeoutMs` in
 * `specs/src/client/timing.json`): how long it takes is how large it is.
 */

import type { AccessToken, AnchoredTextAnswer, ResourceId, PutBinaryOptions, PutBinaryProgress, components } from '@semiont/core';
import { busLog, retryAfterMs } from '@semiont/core';
import { SpanKind, getActiveTraceparent, withSpan } from '@semiont/observability';
import type { HttpTransport } from './http-transport';
import { APIError, refusalBody } from './api-error';
import { declaredBody } from './declared-body';
import type { IContentTransport, PutBinaryRequest } from '@semiont/core';

type GetResourceResponse = components['schemas']['GetResourceResponse'];
type GetAnnotationsResponse = components['schemas']['GetAnnotationsResponse'];

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
        const token = options?.auth ?? this.transport.getToken();
        const headers = this.requestHeaders(token);
        const path = '/resources';
        const url = `${this.transport.baseUrl}${path}`;

        if (typeof XMLHttpRequest !== 'undefined' && (options?.onProgress || options?.signal)) {
          const onProgress = options.onProgress ? neverLess(options.onProgress) : undefined;
          const report = (err: APIError): void => this.transport.pushError(err);
          const send = (sentHeaders: Record<string, string>, onApiError: (err: APIError) => void) =>
            uploadViaXhr({ url, formData, headers: sentHeaders, onProgress, signal: options.signal, onApiError });
          // A refused credential is renewed once, and the upload sent again
          // with the token given (docs/protocol/TRANSPORT-CONTRACT.md § A
          // refused credential). The first refusal is reported only when
          // nothing renews it: a renewed upload that is accepted reports
          // nothing, as one through ky does.
          try {
            return await send(headers, (err) => {
              if (err.code !== 'unauthorized') report(err);
            });
          } catch (error) {
            if (!(error instanceof APIError) || error.code !== 'unauthorized') throw error;
            const renewed = await this.transport.renewal(token);
            if (renewed === null) {
              report(error);
              throw error;
            }
            return send({ ...headers, Authorization: `Bearer ${renewed}` }, report);
          }
        }

        const sent = options?.onProgress
          ? await inPieces(formData, options.onProgress, options.signal)
          : { body: formData, headers: {} };
        const result = await this.transport.ask('POST', path, async (http) =>
          declaredBody(
            'CreateResourceResponse',
            'POST',
            path,
            await http.post(url, {
              body: sent.body,
              headers: { ...headers, ...sent.headers },
              timeout: false,
              ...(options?.signal ? { signal: options.signal } : {}),
            }),
            (failure) => this.transport.pushError(failure),
          ));

        return { resourceId: result.resourceId };
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
    options?: { auth?: AccessToken },
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    busLog('GET', 'content', { resourceId });
    return withSpan(
      'content.get',
      async () => {
        // Pure pipe: no Accept header — the route serves the stored bytes
        // verbatim with their real Content-Type.
        const path = this.pathOf(resourceId);
        const response = await this.transport.ask('GET', path, (http) =>
          http.get(`${this.transport.baseUrl}${path}`, { headers: this.requestHeaders(options?.auth) }));
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const data = await response.arrayBuffer();
        return { data, contentType };
      },
      { kind: SpanKind.CLIENT, attrs: { 'resource.id': resourceId as unknown as string } },
    );
  }

  async getBinaryStream(
    resourceId: ResourceId,
    options?: { auth?: AccessToken },
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
    busLog('GET', 'content', { resourceId, stream: true });
    return withSpan(
      'content.get',
      async () => {
        // Pure pipe: no Accept header (see getBinary).
        const path = this.pathOf(resourceId);
        const response = await this.transport.ask('GET', path, (http) =>
          http.get(`${this.transport.baseUrl}${path}`, { headers: this.requestHeaders(options?.auth) }));
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

  /**
   * Dereference the resource's JSON-LD graph over HTTP — the LD face an
   * external linked-data client sees. Deliberately HTTP, not the bus: the
   * JSON-LD panel shows exactly what such a client gets.
   */
  async getResourceGraph(
    resourceId: ResourceId,
    options?: { auth?: AccessToken },
  ): Promise<GetResourceResponse> {
    busLog('GET', 'content', { resourceId, graph: true });
    return withSpan(
      'content.get_graph',
      () => {
        const path = `${this.pathOf(resourceId)}/jsonld`;
        return this.transport.ask('GET', path, async (http) =>
          declaredBody('GetResourceResponse', 'GET', path, await http.get(`${this.transport.baseUrl}${path}`, { headers: this.requestHeaders(options?.auth) }), (failure) =>
            this.transport.pushError(failure)));
      },
      { kind: SpanKind.CLIENT, attrs: { 'resource.id': resourceId as unknown as string } },
    );
  }

  /**
   * A resource's annotations, from the gateway's
   * `GET /resources/:id/annotations`: the body is the answer.
   */
  async getAnnotations(
    resourceId: ResourceId,
    options?: { auth?: AccessToken },
  ): Promise<GetAnnotationsResponse> {
    busLog('GET', 'content', { resourceId, annotations: true });
    return withSpan(
      'content.get_annotations',
      () => {
        const path = `${this.pathOf(resourceId)}/annotations`;
        return this.transport.ask('GET', path, async (http) =>
          declaredBody('GetAnnotationsResponse', 'GET', path, await http.get(`${this.transport.baseUrl}${path}`, { headers: this.requestHeaders(options?.auth) }), (failure) =>
            this.transport.pushError(failure)));
      },
      { kind: SpanKind.CLIENT, attrs: { 'resource.id': resourceId as unknown as string } },
    );
  }

  /**
   * A resource's anchored text, from the gateway's
   * `GET /resources/:id/anchored-text`: the body is the answer. With no text
   * stored yet, the Archivist holds the request while it waits on the
   * Smelter (docs/protocol/ARCHIVIST.md says how long) before it answers
   * `not-yet`, and the deadline on a request (`httpRequestTimeoutMs`)
   * outlasts that wait.
   */
  async getAnchoredText(
    resourceId: ResourceId,
    options?: { auth?: AccessToken },
  ): Promise<AnchoredTextAnswer> {
    busLog('GET', 'content', { resourceId, anchoredText: true });
    return withSpan(
      'content.get_anchored_text',
      () => {
        const path = `${this.pathOf(resourceId)}/anchored-text`;
        return this.transport.ask('GET', path, async (http) =>
          declaredBody('AnchoredTextAnswer', 'GET', path, await http.get(`${this.transport.baseUrl}${path}`, { headers: this.requestHeaders(options?.auth) }), (failure) =>
            this.transport.pushError(failure)));
      },
      { kind: SpanKind.CLIENT, attrs: { 'resource.id': resourceId as unknown as string } },
    );
  }

  dispose(): void {
    // HttpContentTransport has no resources of its own; HttpTransport owns
    // the ky instance and token subject. No-op is correct here.
  }

  /**
   * Where a resource is read: its id as one segment of the path. A
   * `ResourceId` needs no encoding, by its rule; a caller with no type
   * checker can hand over any text, and that text is one segment too.
   */
  private pathOf(resourceId: ResourceId): string {
    return `/resources/${encodeURIComponent(resourceId)}`;
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
  } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(request.file)) {
    // `Buffer` is a Node global; referencing it bare in the browser throws
    // ReferenceError before the isBuffer call. Browser uploads always hit
    // the File branch above; this branch is for Node-side workers.
    const blob = new Blob([new Uint8Array(request.file)], { type: request.format });
    formData.append('file', blob, request.name);
  } else {
    throw new Error('file must be a File or Buffer');
  }

  if (request.entityTypes && request.entityTypes.length > 0) {
    formData.append('entityTypes', JSON.stringify(request.entityTypes));
  }
  if (request.language) formData.append('language', request.language);
  if (request.sourceAnnotationId) formData.append('sourceAnnotationId', String(request.sourceAnnotationId));
  if (request.sourceResourceId) formData.append('sourceResourceId', String(request.sourceResourceId));
  if (request.generationPrompt) formData.append('generationPrompt', request.generationPrompt);
  if (request.generator) formData.append('generator', JSON.stringify(request.generator));
  if (request.jobId) formData.append('jobId', request.jobId);
  if (request.cloneToken) formData.append('cloneToken', request.cloneToken);
  if (request.archiveOriginal !== undefined) formData.append('archiveOriginal', String(request.archiveOriginal));
  if (request.isDraft !== undefined) formData.append('isDraft', String(request.isDraft));

  return formData;
}

/**
 * How much of an upload's body is handed to the connection at a time: the
 * grain its progress is reported in.
 */
const UPLOAD_PIECE_BYTES = 64 * 1024;

/**
 * The form as a body the connection takes a piece at a time. A piece is
 * reported when it is asked for and never ahead of that, so what is reported
 * is what has been handed over: never the rest of a body waiting behind a
 * connection that has stopped taking it. Once its caller has cancelled, it
 * hands over and reports nothing more.
 *
 * The runtime's own encoding of the form is what is sent, and its length is
 * stated: Node sends the `Content-Length` it is given, so the gateway is told
 * the size as it is for a body that is not streamed. A runtime that keeps
 * that header to itself sends the same bytes chunked.
 *
 * A request sent again with a renewed token is ky's copy of this body, which
 * is read once: what the second sending repeats is not reported a second time.
 */
async function inPieces(
  form: FormData,
  onProgress: PutBinaryProgress,
  signal: AbortSignal | undefined,
): Promise<{ body: ReadableStream<Uint8Array>; headers: Record<string, string> }> {
  const encoded = new Response(form);
  const contentType = encoded.headers.get('content-type');
  if (!contentType) throw new Error('the runtime encoded a form without naming its boundary');
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  let handed = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (signal?.aborted) return;
        const piece = bytes.subarray(handed, handed + UPLOAD_PIECE_BYTES);
        handed += piece.byteLength;
        controller.enqueue(piece);
        if (handed === bytes.byteLength) controller.close();
        onProgress({ bytesUploaded: handed, totalBytes: bytes.byteLength });
      },
    },
    { highWaterMark: 0 },
  );
  return { body, headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.byteLength) } };
}

/**
 * Progress that never goes back: an upload sent a second time reports again
 * only once it is past what the first sending reported.
 */
function neverLess(onProgress: PutBinaryProgress): PutBinaryProgress {
  let reported = 0;
  return (progress) => {
    if (progress.bytesUploaded < reported) return;
    reported = progress.bytesUploaded;
    onProgress(progress);
  };
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
 * A POST through `XMLHttpRequest`, for its `upload.onprogress`. A refusal
 * (4xx/5xx) is reported as it is on the ky path: the `APIError` every
 * refusal is, on `transport.errors$` before the promise rejects. So is a
 * connection that failed. A cancellation rejects with the signal's reason
 * and is not put there.
 */
function uploadViaXhr(opts: XhrUploadOptions): Promise<{ resourceId: ResourceId }> {
  const { url, formData, headers, onProgress, signal, onApiError } = opts;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    try {
      xhr.open('POST', url);
      for (const [name, value] of Object.entries(headers)) {
        xhr.setRequestHeader(name, value);
      }
    } catch (error) {
      // What a browser will not make a request of, it refuses in words that
      // say it: a token that is no header value among them.
      const unanswered = APIError.unanswered('POST /resources', error);
      onApiError(unanswered);
      reject(unanswered);
      return;
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
        let parsed: unknown;
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch (parseErr) {
          const err = APIError.fromStatus(
            `Upload succeeded but response was not valid JSON: ${(parseErr as Error).message}`,
            xhr.status,
            xhr.statusText,
            xhr.responseText,
            retryAfterMs(xhr.getResponseHeader('retry-after')),
          );
          onApiError(err);
          reject(err);
          return;
        }
        const answer = { status: xhr.status, statusText: xhr.statusText, json: () => Promise.resolve(parsed) };
        declaredBody('CreateResourceResponse', 'POST', '/resources', answer, onApiError).then((body) => resolve({ resourceId: body.resourceId }), reject);
        return;
      }
      const err = APIError.refusal(xhr.status, xhr.statusText, refusalBody(xhr.responseText), xhr.getResponseHeader('retry-after'));
      onApiError(err);
      reject(err);
    };

    xhr.onerror = () => {
      // Network-level failure (DNS, TCP reset, CORS). XHR gives no status
      // here; the vocabulary files a failed network under `unavailable`.
      const err = APIError.withoutResponse('Network error during upload', 'network-error');
      onApiError(err);
      reject(err);
    };

    signal?.addEventListener(
      'abort',
      () => {
        xhr.abort();
        reject(signal.reason);
      },
      { once: true },
    );

    xhr.send(formData);
  });
}
