/**
 * LocalContentTransport — `IContentTransport` over an in-process
 * `KnowledgeBase`.
 *
 * Takes the KB, not the whole `KnowledgeSystem`: every read below goes through
 * `kb.*` and no actor is ever touched. The wider parameter forced callers that
 * legitimately hold only a KB to cast (`representation.test.ts` used
 * `as never`), which is a cast hiding nothing but an over-wide signature.
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

import type { AccessToken, ResourceId, components } from '@semiont/core';
import { busLog } from '@semiont/core';
import { SpanKind, withSpan } from '@semiont/observability';
import type { IContentTransport, PutBinaryRequest, PutBinaryOptions } from '@semiont/core';

import type { KnowledgeBase } from './knowledge-base.js';
import { workingTreeContentReads } from './knowledge-base.js';
import { assembleResourceGraph } from './resource-graph.js';

type GetResourceResponse = components['schemas']['GetResourceResponse'];

export class LocalContentTransport implements IContentTransport {
  constructor(private readonly kb: KnowledgeBase) {}

  async putBinary(
    _request: PutBinaryRequest,
    _options?: PutBinaryOptions,
  ): Promise<{ resourceId: ResourceId }> {
    // `onProgress` and `signal` from `_options` are accepted for interface
    // conformance and ignored — local mode has no wire over which bytes
    // flow, so progress events would be synthetic and offer no signal,
    // and the upload is synchronous-ish so cancellation has no window.
    throw new Error(
      'LocalContentTransport does not support putBinary() — create resources via bus emits (mark/yield namespaces) in local mode',
    );
  }





  async getBinary(
    resourceId: ResourceId,
    _options?: { auth?: AccessToken },
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    busLog('GET', 'content', { resourceId });
    return withSpan(
      'content.get',
      () => this.loadBinary(resourceId),
      { kind: SpanKind.INTERNAL, attrs: { 'resource.id': resourceId as unknown as string } },
    );
  }

  async getBinaryStream(
    resourceId: ResourceId,
    _options?: { auth?: AccessToken },
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
    busLog('GET', 'content', { resourceId, stream: true });
    return withSpan(
      'content.get',
      async () => {
        // Local content store is buffer-oriented, not streaming. Read
        // fully and wrap in a one-shot ReadableStream so callers that
        // prefer the streaming surface still work.
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

  /**
   * The same resolution the wire path serves, buffered — local and hosted
   * modes must answer identically, which they did not before
   * SINGLE-KB-MOUNT P3: this resolved through `representations[].storageUri`,
   * a field `ViewMaterializer` never writes, so every binary read here threw.
   */
  private loadBinary(resourceId: ResourceId): Promise<{ data: ArrayBuffer; contentType: string }> {
    return workingTreeContentReads(this.kb.views, this.kb.content).getBinary(resourceId);
  }

  /**
   * Assemble the resource's JSON-LD graph in-process from the KB — the local
   * realization of `IContentTransport.getResourceGraph` (symmetric with
   * getBinary; SIMPLER-JSON-LD.md decision 7). Local mode has no auth.
   */
  async getResourceGraph(
    resourceId: ResourceId,
    _options?: { auth?: AccessToken },
  ): Promise<GetResourceResponse> {
    const graph = await assembleResourceGraph(this.kb, resourceId);
    if (!graph) throw new Error(`Resource not found: ${resourceId}`);
    return graph;
  }

  dispose(): void {
    // KnowledgeBase lifetime is owned by the caller. Nothing to release.
  }
}
