/**
 * LocalContentTransport — `IContentTransport` for an in-process
 * `KnowledgeSystem`.
 *
 * Reads go straight to `kb.views` (resource lookup) + `kb.content`
 * (byte retrieval). No network, no auth — local mode runs as a single
 * host-process identity.
 *
 * `putBinary` is intentionally not implemented in Phase 2: in-process
 * resource creation is exercised through bus emits (mark/yield
 * namespaces), not multipart upload. If a future caller needs raw
 * binary upload from a local context, wire it through the same
 * resource-creation pipeline the HTTP `/resources` handler uses.
 */

import type { AccessToken, ContentFormat, ResourceId, components } from '@semiont/core';
import type { IContentTransport, PutBinaryRequest } from '@semiont/api-client';

import type { KnowledgeSystem } from './knowledge-system.js';

type Representation = components['schemas']['Representation'];

function primaryRepresentation(
  reps: components['schemas']['ResourceDescriptor']['representations'],
): Representation | undefined {
  if (!reps) return undefined;
  return Array.isArray(reps) ? reps[0] : reps;
}

export class LocalContentTransport implements IContentTransport {
  constructor(private readonly ks: KnowledgeSystem) {}

  async putBinary(
    _request: PutBinaryRequest,
    _options?: { auth?: AccessToken },
  ): Promise<{ resourceId: ResourceId }> {
    throw new Error(
      'LocalContentTransport does not support putBinary() — create resources via bus emits (mark/yield namespaces) in local mode',
    );
  }

  async getBinary(
    resourceId: ResourceId,
    _options?: { accept?: ContentFormat | string; auth?: AccessToken },
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    const view = await this.ks.kb.views.get(resourceId);
    if (!view) throw new Error(`Resource not found: ${resourceId}`);
    const rep = primaryRepresentation(view.resource.representations);
    if (!rep?.storageUri) {
      throw new Error(`Resource ${resourceId} has no representation with a storageUri`);
    }
    const buf = await this.ks.kb.content.retrieve(rep.storageUri);
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return { data, contentType: rep.mediaType };
  }

  async getBinaryStream(
    resourceId: ResourceId,
    options?: { accept?: ContentFormat | string; auth?: AccessToken },
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
    // Local content store is buffer-oriented, not streaming. Read fully
    // and wrap in a one-shot ReadableStream so callers that prefer the
    // streaming surface still work.
    const { data, contentType } = await this.getBinary(resourceId, options);
    const bytes = new Uint8Array(data);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return { stream, contentType };
  }

  dispose(): void {
    // KnowledgeSystem lifetime is owned by the caller. Nothing to release.
  }
}
