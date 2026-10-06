/**
 * Resource Context
 *
 * Assembles resource context from view storage and content store. It reads
 * the record only: searching resources is discovery, and the Librarian's
 * (`resource-search.ts`).
 */

import { decodeRepresentation, derivesTextOf, getResourceId, textSourceOf } from '@semiont/core';
import { representationSource } from './representation.js';
import type { AnchoredTextAsk } from './anchored-text-ask.js';
import type { ResourceId } from '@semiont/core';
import type { ViewStorage } from '@semiont/event-sourcing';
import type { ContentReads } from '@semiont/content';

import type { ResourceDescriptor } from '@semiont/core';

export class ResourceContext {
  /**
   * Get resource metadata from view storage
   */
  static async getResourceMetadata(resourceId: ResourceId, kb: { views: Pick<ViewStorage, 'get'> }): Promise<ResourceDescriptor | null> {
    const view = await kb.views.get(resourceId);
    if (!view) {
      return null;
    }

    return view.resource;
  }

  /**
   * Get full content for a resource, as TEXT — the read-side dispatcher
   * (utf-8-decoding a PDF's raw bytes would ship them to inference as
   * text): the media type decides where the text comes from, exactly as
   * it decides who may derive it.
   *
   * - `decode`         — the bytes ARE the text: fetch (ResourceId-keyed)
   *                      and charset-decode.
   * - derived (`derivesTextOf`) — the text is the Smelter's artifact: the
   *                      anchored-text read answers, and its classified
   *                      absences (`not-yet`, `no-map`, `unknown`, a stored
   *                      decline) all mean ABSENT — `undefined`, never `''`
   *                      and never decoded bytes.
   * - `none`           — this media has no text; neither door is touched.
   */
  static async getResourceContent(
    resource: ResourceDescriptor,
    kb: { content: ContentReads; anchoredText: AnchoredTextAsk }
  ): Promise<string | undefined> {
    const id = getResourceId(resource);
    const source = representationSource(resource);
    if (!source || !id) return undefined;

    // Category, not mechanism: a new strategy declares its side in core's
    // exhaustive category maps (`derivesTextOf`), and this dispatch follows
    // automatically — the mechanism literal stays on the extraction side.
    if (textSourceOf(source.mediaType) === 'none') return undefined;
    if (derivesTextOf(source.mediaType)) {
      const answer = await kb.anchoredText(id);
      return answer.kind === 'extracted' ? answer.text : undefined;
    }
    // The bytes are the text. The transport reports the media type it
    // served; the descriptor's is the same fact by construction (both come
    // from the one resolution), so this decodes with what came back rather
    // than re-deriving it.
    const { data, contentType } = await kb.content.getBinary(id);
    return decodeRepresentation(Buffer.from(data), contentType);
  }
}
