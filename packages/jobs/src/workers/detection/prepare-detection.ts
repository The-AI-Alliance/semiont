import type { SemiontSession } from '@semiont/sdk';
import type { ResourceId, TextExtraction, components } from '@semiont/core';
import { extractPdfTextLayer } from '@semiont/content';
import { buildTextAnnotation, buildPdfAnnotation, type BuildAnnotation } from '../../processors';

type Agent = components['schemas']['Agent'];

/**
 * For one detection job, resolve the text the model detects over and the
 * media-appropriate way to turn a detected span into a stored annotation —
 * keyed by the media-type registry's `TextExtraction` strategy
 * (`textExtractionOf`). The detection processors stay media-agnostic: they take
 * the `.text` and the returned `buildAnnotation` and never see a layer or a
 * media type. Adding a media type is a new `case` here, nothing on the processors.
 *
 * Returns `null` when the resource has no usable text (a scanned/image-only PDF,
 * or a non-textual `'none'` type), so the dispatch can decline cleanly instead
 * of running the model on nothing.
 */
export async function prepareDetection(
  strategy: TextExtraction,
  session: SemiontSession,
  resourceId: ResourceId,
  userId: string,
  generator: Agent,
): Promise<{ text: string; buildAnnotation: BuildAnnotation } | null> {
  switch (strategy) {
    case 'decode': {
      const text = await session.client.browse.resourceContent(resourceId as never);
      return {
        text,
        buildAnnotation: (motivation, match, body) =>
          buildTextAnnotation(text, resourceId, userId, generator, motivation, match, body),
      };
    }
    case 'pdf-text-layer': {
      const { data } = await session.client.browse.resourceRepresentation(resourceId as never);
      const layer = await extractPdfTextLayer(new Uint8Array(data));
      if (!layer) return null; // scanned / image-only PDF — no text layer
      return {
        text: layer.text,
        buildAnnotation: (motivation, match, body) =>
          buildPdfAnnotation(layer, resourceId, userId, generator, motivation, match, body),
      };
    }
    case 'none':
      return null;
  }
}
