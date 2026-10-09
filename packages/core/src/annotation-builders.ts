/**
 * The annotation builders: what turns the words a model quoted of a text into
 * annotations to commit.
 *
 *   - `reconcile` finds the quoted words in the text;
 *   - `annotationOfSpan` builds the annotation of a span of a text, or of a
 *     PDF's anchored text;
 *   - `annotationOfResource` builds an annotation of a resource as a whole.
 *
 * Every SDK has these three, and no other builder:
 * specs/src/annotations/builder-cases.json names them and holds the two that
 * build, and specs/src/annotations/reconcile-cases.json holds `reconcile`.
 *
 * A text is a plain string. `start` and `end` are offsets: they count Unicode
 * code points from the start of the text, and so does every length a rule
 * here states. Each function makes the text's conversions for itself
 * (`textOffsets`), so no caller is asked for one.
 *
 * @see https://www.w3.org/TR/annotation-model/#text-quote-selector
 */

import { annotationIdFor } from './annotation-id';
import type { Annotation } from './annotation-types';
import type { Motivation } from './branded-types';
import { SemiontError } from './errors';
import { findBestTextMatch, buildContentCache, type MatchQuality } from './fuzzy-anchor';
import type { SpanRefusal } from './generated/error-codes';
import type { ResourceId } from './identifiers';
import type { Selector } from './payload-types';
import { locate, type AnchoredText } from './pdf-anchoring';
import { createFragmentSelector } from './pdf-coordinates';
import { contextOf } from './text-context';
import { between, occurrencesOf, textOffsets, type TextOffsets } from './text-offsets';
import type { components } from './types';

type Agent = components['schemas']['Agent'];
type TextQuoteSelector = components['schemas']['TextQuoteSelector'];

/**
 * What a model quoted of a text: the words, and maybe what it says stands
 * before and after them. None of it is trusted: the words are looked for in
 * the text, and the context only chooses among the places they are found.
 */
export interface QuotedText {
  exact: string;
  prefix?: string;
  suffix?: string;
}

/**
 * A span of a text: from the offset `start` up to but not including the
 * offset `end`, the text between them (`exact`), and maybe the text just
 * before it (`prefix`) and just after it (`suffix`).
 */
export interface TextSpan {
  /** The offset the span starts at: how many code points of the text are before it. */
  start: number;
  /** The offset just after the span. */
  end: number;
  exact: string;
  prefix?: string;
  suffix?: string;
}

/**
 * How `reconcile` found a span. `first-of-many` is the one to audit: the
 * words are in the text more than once and nothing chose among the places, so
 * the span may be the wrong one of them.
 */
export type AnchorMethod =
  /** The words are in the text once. */
  | 'unique-match'
  /** The words are in the text more than once, and the quoted context chose the place. */
  | 'context-recovered'
  /** The words are in the text more than once, and no context chose: the first place. */
  | 'first-of-many'
  /** The words are not in the text character for character; a looser search found them, `matchQuality` naming which. */
  | 'fuzzy-match';

/**
 * The span `reconcile` found: its `exact`, `prefix` and `suffix` are the
 * text's own, never the model's, and it says how it was found. It is a
 * `TextSpan`, so it is what `annotationOfSpan` takes.
 */
export interface ReconciledSpan extends TextSpan {
  anchorMethod: AnchorMethod;
  /** Which looser search found the span: stated when `anchorMethod` is `fuzzy-match`, and only then. */
  matchQuality?: MatchQuality;
}

/**
 * A span `annotationOfSpan` refused. `code` names the refusal: one of the
 * `spanRefusal` codes of specs/src/errors/codes.json, the table every SDK's
 * codes are generated from.
 */
export class SpanRefusedError extends SemiontError {
  declare code: SpanRefusal;

  constructor(message: string, code: SpanRefusal) {
    super(message, code);
    this.name = 'SpanRefusedError';
  }
}

/** A stretch of the text, as two offsets: from `start` up to but not including `end`. */
interface Place {
  start: number;
  end: number;
}

// Minimum window of the text compared against a quoted prefix or suffix when
// choosing among several places, in code points. The actual window grows to
// the length of the quoted prefix or suffix when that is longer: a model is
// invited to quote up to 64 code points of context, and a fixed window of 32
// can't `endsWith`/`includes` a string of 64, which would silently defeat the
// choice for exactly the long, distinctive contexts that choose best.
const DISAMBIGUATION_MIN_WINDOW = 32;

/**
 * Find the words a model quoted in a text. The answer is a span whose `start`
 * and `end` bracket `exact` in the text, and whose `exact`, `prefix` and
 * `suffix` are the text's own: nothing the model said is carried into it, so
 * what an annotation built on it states is verifiable against the text.
 *
 * `null` when `quoted.exact` is empty or only white space, or is nowhere in
 * the text, even loosely. A caller drops the proposal, and says so.
 */
export function reconcile(text: string, quoted: QuotedText): ReconciledSpan | null {
  const { exact } = quoted;
  // Nothing, or only white space, is no words to find.
  if (exact.trim() === '') return null;

  const offsets = textOffsets(text);

  /** What the model said stands beside `exact`, when that is more than white space: a hint of where. */
  const hint = (given: string | undefined): string | undefined =>
    given === undefined || given.trim() === '' ? undefined : given;
  const prefixHint = hint(quoted.prefix);
  const suffixHint = hint(quoted.suffix);

  // Size the comparison window to the hint (with a floor), so a prefix of 64
  // code points is matched against at least 64 of the text — a fixed smaller
  // window can't `endsWith`/`includes` a longer string.
  const prefixWindow = Math.max(DISAMBIGUATION_MIN_WINDOW, prefixHint === undefined ? 0 : textOffsets(prefixHint).length);
  const suffixWindow = Math.max(DISAMBIGUATION_MIN_WINDOW, suffixHint === undefined ? 0 : textOffsets(suffixHint).length);

  /** Whether the text around a place carries every hint given. */
  const fits = ({ start, end }: Place): boolean => {
    const before = between(text, offsets, Math.max(0, start - prefixWindow), start);
    const after = between(text, offsets, end, Math.min(offsets.length, end + suffixWindow));
    const prefixOk = prefixHint === undefined || before.endsWith(prefixHint) || before.includes(prefixHint.trim());
    const suffixOk = suffixHint === undefined || after.startsWith(suffixHint) || after.includes(suffixHint.trim());
    return prefixOk && suffixOk;
  };

  /** The first of several places that the hints pick: none when no hint was given, or no place fits. */
  const hinted = (places: Place[]): Place | undefined =>
    prefixHint === undefined && suffixHint === undefined ? undefined : places.find(fits);

  /** A place as a span: its words and its context are the text's own. */
  const spanAt = ({ start, end }: Place): TextSpan => {
    const context = contextOf(text, offsets, start, end);
    return {
      start,
      end,
      // The text's words, not the model's version of them — the model may
      // have written slightly different characters (smart or straight
      // quotes, say) and what is stored is what is verifiable.
      exact: between(text, offsets, start, end),
      ...(context.prefix !== undefined ? { prefix: context.prefix } : {}),
      ...(context.suffix !== undefined ? { suffix: context.suffix } : {}),
    };
  };

  // Find every place the text has `exact`, character for character: each as long as `exact` is in code points.
  const length = textOffsets(exact).length;
  const occurrences: Place[] = occurrencesOf(text, offsets, exact).map((start) => ({ start, end: start + length }));

  if (occurrences.length === 1) {
    return { ...spanAt(occurrences[0]!), anchorMethod: 'unique-match' };
  }

  if (occurrences.length > 1) {
    const chosen = hinted(occurrences);
    if (chosen !== undefined) return { ...spanAt(chosen), anchorMethod: 'context-recovered' };

    // No context chose. Fall back to the first place and flag it for audit:
    // with no hint of where, there is no better signal at this stage, and a
    // caller that sees `first-of-many` should log it loudly so an operator
    // can correct an annotation anchored at the wrong one.
    return { ...spanAt(occurrences[0]!), anchorMethod: 'first-of-many' };
  }

  // The text has `exact` nowhere. Try the looser searches (white space and
  // the forms of quotation marks and dashes disregarded, letter case
  // disregarded, edit distance within a twentieth of the length). Of several
  // places one of them finds, the hints choose as they do among the places
  // the text has `exact`, and the first is taken when they choose none.
  const found = findBestTextMatch(text, exact, buildContentCache(text));
  if (!found) return null;
  return {
    ...spanAt(hinted(found.places) ?? found.places[0]!),
    anchorMethod: 'fuzzy-match',
    matchQuality: found.matchQuality,
  };
}

/** What a refusal is said of: the annotation that was to be built. */
interface Refused {
  resourceId: ResourceId;
  motivation: Motivation;
}

function refuse(code: SpanRefusal, why: string, { resourceId, motivation }: Refused): never {
  throw new SpanRefusedError(`annotationOfSpan refused a span (${code}): ${why}, for resource ${resourceId}, motivation ${motivation}`, code);
}

/**
 * Refuse a span that is no span of the text: one given backwards, one that
 * runs past the end, one that starts below zero, one stated in fractions.
 * Whatever words lie between its two numbers, it names no stretch of the
 * text, and an annotation built on it would state offsets that anchor nothing.
 */
function holdSpanToText(offsets: TextOffsets, { start, end }: TextSpan, of: Refused): void {
  if (Number.isInteger(start) && Number.isInteger(end) && 0 <= start && start <= end && end <= offsets.length) return;
  refuse('span-out-of-range', `offsets ${start} to ${end} are not a span of a text of ${offsets.length} code points`, of);
}

/**
 * Refuse a prefix or a suffix that is not what the text has on that side of
 * the span: as many code points of it as the prefix or suffix has itself, or
 * all there are if fewer. `span` is a span of the text (`holdSpanToText`).
 */
function holdContextToText(text: string, offsets: TextOffsets, span: TextSpan, of: Refused): void {
  if (span.prefix !== undefined) {
    const from = Math.max(0, span.start - textOffsets(span.prefix).length);
    if (between(text, offsets, from, span.start) !== span.prefix) {
      refuse('prefix-mismatch', `the prefix is not the text just before offset ${span.start}`, of);
    }
  }
  if (span.suffix !== undefined) {
    const to = Math.min(offsets.length, span.end + textOffsets(span.suffix).length);
    if (between(text, offsets, span.end, to) !== span.suffix) {
      refuse('suffix-mismatch', `the suffix is not the text just after offset ${span.end}`, of);
    }
  }
}

/**
 * The selectors of a span of a text: its position, and its quote. The span
 * is first held to the text, then its words, then its context.
 */
function selectorsInText(text: string, span: TextSpan, of: Refused): Selector[] {
  const offsets = textOffsets(text);
  holdSpanToText(offsets, span, of);
  if (between(text, offsets, span.start, span.end) !== span.exact) {
    refuse('exact-mismatch', `the text from offset ${span.start} to offset ${span.end}, which count code points, is not exact`, of);
  }
  holdContextToText(text, offsets, span, of);
  return [{ type: 'TextPositionSelector', start: span.start, end: span.end }, quoteOf(span)];
}

/**
 * The selectors of a span of a PDF's anchored text: one `FragmentSelector`
 * for each line the span is on (`locate` joins the items it overlaps into a
 * rectangle a line), and its quote. No `TextPositionSelector`: the anchored
 * text is derived from the PDF and is not its stored content, so an offset
 * into it is no durable anchor.
 *
 * The rectangles are of whole items (runs of words), so the text those items
 * cover must *have* `exact` in it, white space apart: containment, not
 * equality. A span that overlaps no item has no rectangle, and is refused
 * under a name of its own: merged with the other, it would send whoever
 * reads the refusal to a comparison of words that never ran.
 *
 * The span is held to the anchored text first, and its prefix and suffix
 * after, exactly as a span of a text is held to its text: the quote this
 * writes is what re-anchoring reads, on a PDF as on a text.
 */
function selectorsInPdf(anchored: AnchoredText, span: TextSpan, of: Refused): Selector[] {
  const offsets = textOffsets(anchored.text);
  holdSpanToText(offsets, span, of);

  // `locate` answers both the rectangles and the items they were made from:
  // the covered text is read from those, with no second pass over the items.
  const { rects, overlap } = locate(anchored, span.start, span.end);
  const covered = overlap.length
    ? between(
        anchored.text,
        offsets,
        Math.min(...overlap.map((item) => item.start)),
        Math.max(...overlap.map((item) => item.end)),
      )
    : '';
  const collapsed = (words: string): string => words.replace(/\s+/g, ' ').trim();
  if (rects.length === 0) {
    refuse('nothing-located', `no rectangle is located for offsets ${span.start} to ${span.end}`, of);
  }
  if (!collapsed(covered).includes(collapsed(span.exact))) {
    refuse('exact-not-covered', 'the text the span covers does not have exact in it', of);
  }
  holdContextToText(anchored.text, offsets, span, of);

  return [
    ...rects.map((rect) => ({
      type: 'FragmentSelector' as const,
      conformsTo: 'http://tools.ietf.org/rfc/rfc3778',
      value: createFragmentSelector(rect),
    })),
    quoteOf(span),
  ];
}

/** A span's quote: its words, and its context where it has any. */
function quoteOf(span: TextSpan): TextQuoteSelector {
  return {
    type: 'TextQuoteSelector',
    exact: span.exact,
    ...(span.prefix ? { prefix: span.prefix } : {}),
    ...(span.suffix ? { suffix: span.suffix } : {}),
  };
}

/**
 * Where a span is, for its annotation's id. The words are in it, not just
 * the offsets: after the text changes the same offsets cover other words, and
 * that is another annotation. It is made the same way for a text and for a
 * PDF: a PDF's rectangles are derived from these offsets, so hashing them too
 * would tell no two annotations apart, and would make an id depend on a
 * layout a text cannot reproduce.
 */
function anchorOf(span: TextSpan): string {
  return `${span.start}:${span.end}:${span.exact}`;
}

/**
 * Build the annotation of a span: of a text when `text` is given, of a PDF
 * when its `anchored` text is. The span is one `reconcile` found, or any
 * other the caller can state.
 *
 * The annotation's selectors are made from the span, and its `id` is derived
 * from what it is (the resource, the motivation, the body and where the span
 * is), so building the same annotation again builds the same id, and
 * committing it again writes nothing new. `generator` says what made it;
 * who asked for it is no member of an annotation a builder makes, and is
 * derived where the annotation is recorded. `created` is the moment it is
 * built.
 *
 * `body` is one body or a list of them, or nothing: an annotation whose
 * motivation alone says what it means (a highlight) has none.
 *
 * Throws `SpanRefusedError` for a span that is not the text's: its `code` is
 * the refusal, and the first check that fails names it.
 */
export function annotationOfSpan(
  of: {
    resourceId: ResourceId;
    generator: Agent;
    motivation: Motivation;
    span: TextSpan;
    body?: Annotation['body'];
  } & ({ text: string; anchored?: never } | { anchored: AnchoredText; text?: never }),
): Annotation {
  const { resourceId, generator, motivation, span, body } = of;
  const selector = of.text !== undefined ? selectorsInText(of.text, span, of) : selectorsInPdf(of.anchored, span, of);
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationIdFor({ resourceId, motivation, anchor: anchorOf(span), body }),
    motivation,
    generator,
    created: new Date().toISOString(),
    target: { type: 'SpecificResource', source: resourceId, selector },
    ...(body !== undefined ? { body } : {}),
  };
}

/**
 * Build an annotation of a resource as a whole: its target is the resource,
 * with no selector. The link from a source to what was generated from it is
 * one.
 *
 * Its `id` is derived as a span's annotation's is, from the resource, the
 * motivation and the body: it is anchored nowhere on the resource, and its
 * anchor is the empty string. `generator` says what made it, when something
 * is given; `created` is the moment it is built.
 */
export function annotationOfResource(of: {
  resourceId: ResourceId;
  motivation: Motivation;
  generator?: Agent;
  body?: Annotation['body'];
}): Annotation {
  const { resourceId, motivation, generator, body } = of;
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationIdFor({ resourceId, motivation, anchor: '', body }),
    motivation,
    ...(generator !== undefined ? { generator } : {}),
    created: new Date().toISOString(),
    target: { source: resourceId },
    ...(body !== undefined ? { body } : {}),
  };
}
