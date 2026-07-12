/**
 * Citation-token resolver (INLINE-CITATIONS P1).
 *
 * Under `cite`, the generation prompt asks the model to emit `[[<resourceId>]]` /
 * `[[<resourceId>/<annotationId>]]` transport tokens after each claim, citing ids
 * the context embedding put in front of it (CONTEXT-IDENTIFIERS). Tokens are
 * TRANSPORT, not content: this resolver parses them, validates each id against the
 * ids actually present in the embedded context (the hallucination guard — an
 * unknown id is dropped loudly, never silently linked), STRIPS them from the
 * content before upload, and returns claim-span citations the worker mints as W3C
 * linking annotations on the derived resource. See .plans/INLINE-CITATIONS.md.
 */
import type { GatheredContext, Logger } from '@semiont/core';

export interface GenerationCitation {
  /** The cited source resource (validated present in the embedded context). */
  resourceId: string;
  /** The contributing annotation, when the cited excerpt was annotation-derived. */
  annotationId?: string;
  /** Claim span in the FINAL (token-stripped) content; substring(start, end) === exact. */
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
  let clean = '';
  let last = 0;

  for (const match of content.matchAll(CITATION_TOKEN)) {
    const token = match[0];
    const citedResourceId = match[1]!;
    const annotationId = match[2];

    // Append the text before the token, dropping the whitespace run immediately
    // preceding it so stripping never leaves a dangling space.
    clean += content.slice(last, match.index).replace(/[ \t]+$/, '');
    last = match.index! + token.length;

    if (!validResourceIds.has(citedResourceId)) {
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
    const exact = clean.slice(start, end);
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

  clean += content.slice(last);
  return { content: clean, citations };
}
