/**
 * HttpContentTransport — binary I/O over HTTP.
 *
 * Phase 1 of TRANSPORT-ABSTRACTION. Narrow by design because binary has
 * different backpressure and streaming characteristics than typed command
 * payloads. Uses the HttpTransport's underlying ky instance + token, so
 * retries, logging, and auth behave identically to the rest of the wire.
 */

import type { AccessToken, ContentFormat, ResourceId } from '@semiont/core';
import type { HttpTransport } from './http-transport';
import type { IContentTransport, PutBinaryRequest } from './types';

export class HttpContentTransport implements IContentTransport {
  constructor(private readonly transport: HttpTransport) {}

  async putBinary(
    request: PutBinaryRequest,
    options?: { auth?: AccessToken },
  ): Promise<{ resourceId: ResourceId }> {
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

    const result = await this.transport.rawHttp
      .post(`${this.transport.baseUrl}/resources`, {
        body: formData,
        headers: this.authHeaders(options?.auth),
      })
      .json<{ resourceId: string }>();

    return { resourceId: result.resourceId as ResourceId };
  }

  async getBinary(
    resourceId: ResourceId,
    options?: { accept?: ContentFormat | string; auth?: AccessToken },
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    const response = await this.transport.rawHttp.get(`${this.transport.baseUrl}/resources/${resourceId}`, {
      headers: {
        Accept: options?.accept ?? 'text/plain',
        ...this.authHeaders(options?.auth),
      },
    });
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const data = await response.arrayBuffer();
    return { data, contentType };
  }

  async getBinaryStream(
    resourceId: ResourceId,
    options?: { accept?: ContentFormat | string; auth?: AccessToken },
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
    const response = await this.transport.rawHttp.get(`${this.transport.baseUrl}/resources/${resourceId}`, {
      headers: {
        Accept: options?.accept ?? 'text/plain',
        ...this.authHeaders(options?.auth),
      },
    });
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    if (!response.body) {
      throw new Error('Response body is null - cannot create stream');
    }
    return { stream: response.body, contentType };
  }

  dispose(): void {
    // HttpContentTransport has no resources of its own; HttpTransport owns
    // the ky instance and token subject. No-op is correct here.
  }

  private authHeaders(override?: AccessToken): Record<string, string> {
    const token = override ?? this.transport.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
}
