/**
 * Citation-token resolver.
 *
 * Under `cite`, the generation prompt asks the model to emit `[[<resourceId>]]` /
 * `[[<resourceId>/<annotationId>]]` transport tokens after each claim, citing ids
 * the context embedding put in front of it: every embedded excerpt carries a
 * `[<resourceId>]` handle. Tokens are TRANSPORT, not content: this resolver parses
 * them, validates each id against the ids actually present in the embedded context
 * (the hallucination guard — an unknown id is dropped loudly, never silently
 * linked), STRIPS them from the content before upload, and returns claim-span
 * citations the worker mints as W3C linking annotations on the derived resource.
 */
import { isResourceId, type GatheredContext, type Logger, type ResourceId } from '@semiont/core';

export interface GenerationCitation {
  /** The cited source resource (validated present in the embedded context). */
  resourceId: ResourceId;
  /** The contributing annotation, when the cited excerpt was annotation-derived. */
  annotationId?: string;
  /**
   * The claim's span in the FINAL (token-stripped) content, as two offsets:
   * they count its code points, and the text between them is `exact`.
   */
  start: number;
  end: number;
  exact: string;
}

/** `[[rid]]` or `[[rid/annId]]` — ids are bare (no whitespace, brackets, or slashes). */
const CITATION_TOKEN = /\[\[([^\s[\]/]+)(?:\/([^\s[\]/]+))?\]\]/g;

/**
 * The ids the context embedding actually put in front of the model — the
 * hallucination guard's ground truth. Mirrors what the prompt renderers label:
 * the focal resource, graph resource nodes, semantic matches, related content.
 */
export function collectContextResourceIds(context: GatheredContext | undefined): Set<string> {
  const ids = new Set<string>();
  if (!context) return ids;

  const { focus } = context;
  ids.add(focus.kind === 'annotation' ? focus.sourceResource['@id'] : focus.resource['@id']);
  for (const node of context.graph.nodes) {
    if (node.type === 'resource') ids.add(node.id);
  }
  for (const m of context.semanticContext?.similar ?? []) ids.add(m.resourceId);
  if (focus.kind === 'resource') {
    for (const id of Object.keys(focus.content?.related ?? {})) ids.add(id);
  }
  return ids;
}

export function resolveCitationTokens(
  content: string,
  validResourceIds: ReadonlySet<string>,
  logger: Logger,
): { content: string; citations: GenerationCitation[] } {
  const citations: GenerationCitation[] = [];
  // The resolved content, a code point to an element: a position in it is an
  // offset, and a claim's span is counted as the wire states one.
  const clean: string[] = [];
  /** Where `content` has been read to: its string's position, just past the last token. */
  let last = 0;

  for (const match of content.matchAll(CITATION_TOKEN)) {
    const token = match[0];
    const citedResourceId = match[1]!;
    const annotationId = match[2];

    // Append the text before the token, dropping the whitespace run immediately
    // preceding it so stripping never leaves a dangling space.
    for (const codePoint of content.slice(last, match.index).replace(/[ \t]+$/, '')) clean.push(codePoint);
    last = match.index! + token.length;

    if (!isResourceId(citedResourceId) || !validResourceIds.has(citedResourceId)) {
      logger.warn('Citation token references an id absent from the provided context — dropped', {
        resourceId: citedResourceId,
      });
      continue;
    }

    // Claim span: the sentence preceding the token, computed against the clean
    // content. Offsets are final — later appends never shift earlier positions.
    const end = clean.length;
    let start = 0;
    for (let i = end - 2; i >= 0; i--) {
      const ch = clean[i];
      if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') {
        start = i + 1;
        break;
      }
    }
    while (start < end && /\s/.test(clean[start]!)) start++;
    const exact = clean.slice(start, end).join('');
    if (exact.length === 0) {
      logger.warn('Citation token has no preceding claim text — dropped', {
        resourceId: citedResourceId,
      });
      continue;
    }

    citations.push({
      resourceId: citedResourceId,
      ...(annotationId ? { annotationId } : {}),
      start,
      end,
      exact,
    });
  }

  return { content: clean.join('') + content.slice(last), citations };
}
