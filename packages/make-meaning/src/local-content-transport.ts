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

import type { AccessToken, ExtractionOutcome, ResourceId, components } from '@semiont/core';
import { busLog } from '@semiont/core';
import { SpanKind, withSpan } from '@semiont/observability';
import type { IContentTransport, PutBinaryRequest, PutBinaryOptions } from '@semiont/core';

import type { KnowledgeSystem } from './knowledge-system.js';
import { workingTreeContentReads } from './knowledge-base.js';
import { assembleResourceGraph } from './resource-graph.js';
import { readAnchoredText } from './read-anchored-text.js';

type GetResourceResponse = components['schemas']['GetResourceResponse'];

export class LocalContentTransport implements IContentTransport {
  constructor(private readonly ks: KnowledgeSystem) {}

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

  /**
   * Store a derived coordinate map under the content checksum the producer
   * read (PERSIST-ANCHORS decision A — see the interface doc for why the
   * producer supplies the key). In local mode this is the same store the
   * HTTP route writes to — one storage authority, reached the same way from
   * every process (ANCHORED-TEXT-CACHE Lane 5).
   */
  async putAnchoredText(
    checksum: string,
    outcome: ExtractionOutcome,
    _options?: { auth?: AccessToken },
  ): Promise<void> {
    busLog('PUT', 'anchored-text', { checksum });
    await this.ks.kb.anchoredText.write(checksum, outcome);
  }

  /** The stored outcome, or null when nothing has derived one — the common case. */
  async getAnchoredText(
    resourceId: ResourceId,
    _options?: { auth?: AccessToken },
  ): Promise<ExtractionOutcome | null> {
    busLog('GET', 'anchored-text', { resourceId });
    // The same barrier the wire path applies, from the same function: local and
    // hosted modes must answer identically at the same moment.
    return readAnchoredText(this.ks.kb, resourceId as unknown as string);
  }

  /**
   * The cache-consult read (PERSIST-ANCHORS P2c), straight from the store —
   * checksum-addressed, so no view resolution and no settle barrier: the
   * caller holds the content identity already.
   */
  async getAnchoredTextByChecksum(
    checksum: string,
    _options?: { auth?: AccessToken },
  ): Promise<ExtractionOutcome | null> {
    busLog('GET', 'anchored-text-by-checksum', { checksum });
    return this.ks.kb.anchoredText.read(checksum);
  }

  /**
   * The store's would-hit keys, straight from the store — planning data for
   * the reconcile diff (PERSIST-ANCHORS P0), so no settle barrier applies:
   * presence is being asked, not content at a moment.
   */
  async listAnchoredTextKeys(_options?: { auth?: AccessToken }): Promise<string[]> {
    busLog('GET', 'anchored-text-keys', {});
    return this.ks.kb.anchoredText.list();
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
    return workingTreeContentReads(this.ks.kb.views, this.ks.kb.content).getBinary(resourceId);
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
    const graph = await assembleResourceGraph(this.ks.kb, resourceId);
    if (!graph) throw new Error(`Resource not found: ${resourceId}`);
    return graph;
  }

  dispose(): void {
    // KnowledgeSystem lifetime is owned by the caller. Nothing to release.
  }
}
