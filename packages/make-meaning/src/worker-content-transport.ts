/**
 * WorkerContentTransport — `IContentTransport` for standalone workers with
 * direct (mounted) access to the project working tree.
 *
 * The smelter container has two privileged attachments: the vector store
 * (Qdrant, direct) and the content store (the KB working tree, bind-mounted
 * read-only). Metadata still flows over the bus — `getBinary` resolves the
 * resource descriptor via `browse:resource-requested`, then reads the
 * primary representation's bytes straight off disk via `WorkingTreeStore`.
 * Bytes never cross the HTTP wire.
 *
 * `putBinary` is not implemented: workers using this transport are content
 * readers; resource creation goes through the backend's `/resources` route.
 */

import type { AccessToken, ContentFormat, ResourceId, ResourceDescriptor } from '@semiont/core';
import { busLog, getPrimaryRepresentation } from '@semiont/core';
import { SpanKind, withSpan } from '@semiont/observability';
import type { IContentTransport, PutBinaryRequest, PutBinaryOptions } from '@semiont/core';
import type { WorkingTreeStore } from '@semiont/content';
import { busRequest, type BusRequestPrimitive } from '@semiont/sdk';

export class WorkerContentTransport implements IContentTransport {
  constructor(
    private readonly bus: BusRequestPrimitive,
    private readonly store: WorkingTreeStore,
  ) {}

  async putBinary(
    _request: PutBinaryRequest,
    _options?: PutBinaryOptions,
  ): Promise<{ resourceId: ResourceId }> {
    throw new Error(
      'WorkerContentTransport does not support putBinary() — workers read content; creation goes through the backend /resources route',
    );
  }

  async getBinary(
    resourceId: ResourceId,
    options?: { accept?: ContentFormat | string; auth?: AccessToken },
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    busLog('GET', 'content', { resourceId, accept: options?.accept });
    return withSpan(
      'content.get',
      () => this.loadBinary(resourceId),
      { kind: SpanKind.INTERNAL, attrs: { 'resource.id': resourceId as unknown as string } },
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
        // The working tree is buffer-oriented, not streaming. Read fully
        // and wrap in a one-shot ReadableStream so callers that prefer the
        // streaming surface still work.
        const { data, contentType } = await this.loadBinary(resourceId);
        const bytes = new Uint8Array(data);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
        return { stream, contentType };
      },
      {
        kind: SpanKind.INTERNAL,
        attrs: { 'resource.id': resourceId as unknown as string, 'content.stream': true },
      },
    );
  }

  private async loadBinary(
    resourceId: ResourceId,
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    const result = await busRequest<{ resource: ResourceDescriptor }>(
      this.bus,
      'browse:resource-requested',
      { resourceId },
      'browse:resource-result',
      'browse:resource-failed',
    );
    const rep = getPrimaryRepresentation(result.resource);
    if (!rep?.storageUri) {
      throw new Error(`Resource ${resourceId} has no representation with a storageUri`);
    }
    const buf = await this.store.retrieve(rep.storageUri);
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return { data, contentType: rep.mediaType };
  }

  dispose(): void {
    // Bus and store lifetimes are owned by the caller. Nothing to release.
  }
}
