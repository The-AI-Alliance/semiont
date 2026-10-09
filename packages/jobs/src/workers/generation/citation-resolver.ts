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
import { isAnnotationId, isResourceId, type GatheredContext, type Logger, type ResourceId } from '@semiont/core';

export interface GenerationCitation {
  /** The cited source resource (validated present in the embedded context). */
  resourceId: ResourceId;
  /** The contributing annotation, when the cited excerpt was annotation-derived (validated the same way). */
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

/** The marks that end a sentence. */
const SENTENCE_MARKS: ReadonlySet<string> = new Set(['.', '!', '?']);
/**
 * What may follow a sentence's mark and still be the sentence's own: a closing
 * quotation mark or bracket, and the marks that close emphasis and code in
 * Markdown, which a generated text is written in (`**Bold.**`).
 */
const CLOSERS: ReadonlySet<string> = new Set(['"', "'", '\u201d', '\u2019', '\u00bb', ')', ']', '}', '*', '_', '`', '~']);
const DIGIT = /^[0-9]$/;

/** The ids a gathered context makes citable: what the hallucination guard holds a token to. */
export interface CitableIds {
  resourceIds: ReadonlySet<string>;
  annotationIds: ReadonlySet<string>;
}

/**
 * The ids the context embedding actually put in front of the model — the
 * hallucination guard's ground truth. Mirrors what the prompt renderers label:
 * the focal resource, graph resource nodes, semantic matches, related content;
 * and, of annotations, the one a semantic match came from, which is the only
 * annotation id a label carries.
 */
export function collectCitableIds(context: GatheredContext | undefined): CitableIds {
  const resourceIds = new Set<string>();
  const annotationIds = new Set<string>();
  if (!context) return { resourceIds, annotationIds };

  const { focus } = context;
  resourceIds.add(focus.kind === 'annotation' ? focus.sourceResource['@id'] : focus.resource['@id']);
  for (const node of context.graph.nodes) {
    if (node.type === 'resource') resourceIds.add(node.id);
  }
  for (const m of context.semanticContext?.similar ?? []) {
    resourceIds.add(m.resourceId);
    if (m.annotationId !== undefined) annotationIds.add(m.annotationId);
  }
  if (focus.kind === 'resource') {
    for (const id of Object.keys(focus.content?.related ?? {})) resourceIds.add(id);
  }
  return { resourceIds, annotationIds };
}

/**
 * Whether the character at `at` closes a sentence: a line feed, or a sentence
 * mark. A full stop between two digits closes none: it is inside a number. A
 * full stop after an abbreviation closes one like any other; no abbreviation
 * is known here.
 */
function closesSentence(text: readonly string[], at: number): boolean {
  const character = text[at]!;
  if (character === '\n') return true;
  if (!SENTENCE_MARKS.has(character)) return false;
  const before = text[at - 1];
  const after = text[at + 1];
  return !(character === '.' && before !== undefined && after !== undefined && DIGIT.test(before) && DIGIT.test(after));
}

/**
 * The claim a token cites: the sentence that ends the text resolved so far,
 * with its closing marks, as two offsets into that text. `text` is a code
 * point to an element. Undefined when there is no claim to cite.
 */
function claimBefore(text: readonly string[]): { start: number; end: number } | undefined {
  // The claim ends where the text does, less the white space at its end: a
  // token on a line of its own cites the sentence on the line before.
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1]!)) end--;

  // Its closing marks are its own, however many: an ellipsis, `?!`, a full
  // stop inside a closing quotation mark, a bracket or emphasis.
  let marks = end;
  while (marks > 0 && (SENTENCE_MARKS.has(text[marks - 1]!) || CLOSERS.has(text[marks - 1]!))) marks--;

  // What closes the sentence before is the nearest close ahead of those.
  let start = 0;
  for (let i = marks - 1; i >= 0; i--) {
    if (!closesSentence(text, i)) continue;
    start = i + 1;
    // The closers that follow a sentence mark at once belong to the sentence
    // it closed. One after white space does not: an asterisk there is a list
    // item's bullet, and begins the claim.
    if (text[i] !== '\n') while (start < end && CLOSERS.has(text[start]!)) start++;
    break;
  }
  while (start < end && /\s/.test(text[start]!)) start++;
  return start < end ? { start, end } : undefined;
}

export function resolveCitationTokens(
  content: string,
  citable: CitableIds,
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

    // Append the text before the token, dropping the run of spaces and tabs
    // immediately preceding it so stripping never leaves a dangling space.
    for (const codePoint of content.slice(last, match.index).replace(/[ \t]+$/, '')) clean.push(codePoint);
    last = match.index! + token.length;

    if (!isResourceId(citedResourceId) || !citable.resourceIds.has(citedResourceId)) {
      logger.warn('Citation token references an id absent from the provided context — dropped', {
        resourceId: citedResourceId,
      });
      continue;
    }
    // The annotation a token names is held to what the resource is: an id by
    // the spec's rule, and one the context showed. What a model invents is
    // never linked, and a token half invented cites nothing.
    if (annotationId !== undefined && (!isAnnotationId(annotationId) || !citable.annotationIds.has(annotationId))) {
      logger.warn('Citation token references an annotation absent from the provided context — dropped', {
        resourceId: citedResourceId,
        annotationId,
      });
      continue;
    }

    // Computed against the clean content. Offsets are final — later appends
    // never shift earlier positions.
    const claim = claimBefore(clean);
    if (claim === undefined) {
      logger.warn('Citation token has no preceding claim text — dropped', {
        resourceId: citedResourceId,
      });
      continue;
    }

    citations.push({
      resourceId: citedResourceId,
      ...(annotationId ? { annotationId } : {}),
      start: claim.start,
      end: claim.end,
      exact: clean.slice(claim.start, claim.end).join(''),
    });
  }

  return { content: clean.join('') + content.slice(last), citations };
}
