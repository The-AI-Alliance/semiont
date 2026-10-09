/**
 * Response parsers for annotation detection motivations
 *
 * Static methods that validate the model's already-parsed elements for each
 * motivation type and anchor each span in the document: the model emits no
 * offsets, `reconcileSelector` computes them. A match's `start` and `end`
 * count code points; `offsets`, wherever it is taken, is the content's own
 * conversions (`textOffsets(content)`), made once where the content is first
 * held.
 *
 * What a parser has to say of a reply (how many of its elements were
 * proposals, each proposal it could not anchor) it says to the `logger` it is
 * handed: a worker writes nothing that is not a log line.
 */

import { reconcileSelector, isObject, isString, type Logger, type TextOffsets } from '@semiont/core';
import type { ElementSchema } from '@semiont/inference';
import { noteAnchor } from './anchor-audit';

// Parsers receive ALREADY-PARSED elements (`unknown[]`) from the structured
// inference surface — `generateStructured` returns `T[]` or throws, so
// "could not read the model" never reaches this layer and there is no string
// to parse here. This layer does per-element structural validation (the last
// line on the Ollama path and the schema/type drift guard) plus reconciliation
// against the full document.
//
// Each element schema is declared ADJACENT to the Match interface it mirrors:
// the schema constrains the wire, the interface is what the code consumes,
// and nothing verifies they agree — adjacency is the drift guard.
// `prefix`/`suffix` stay OUT of `required` deliberately: requiring them turns
// "sometimes absent" into "always present, sometimes empty" (measured), an
// anchoring-path change avoided at the source here; `reconcileSelector` also
// treats an empty hint as an absent one.

/**
 * Represents a detected comment with validated position
 */
export interface CommentMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
  comment: string;
}

/** Wire schema for one comment element — keep in lockstep with `CommentMatch`. */
export const COMMENT_ELEMENT_SCHEMA: ElementSchema = {
  type: 'object',
  properties: {
    exact: { type: 'string' },
    prefix: { type: 'string' },
    suffix: { type: 'string' },
    comment: { type: 'string' },
  },
  required: ['exact', 'comment'],
  additionalProperties: false,
};

/**
 * Represents a detected highlight with validated position
 */
export interface HighlightMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
}

/** Wire schema for one highlight element — keep in lockstep with `HighlightMatch`. */
export const HIGHLIGHT_ELEMENT_SCHEMA: ElementSchema = {
  type: 'object',
  properties: {
    exact: { type: 'string' },
    prefix: { type: 'string' },
    suffix: { type: 'string' },
  },
  required: ['exact'],
  additionalProperties: false,
};

/**
 * Represents a detected assessment with validated position
 */
export interface AssessmentMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
  assessment: string;
}

/** Wire schema for one assessment element — keep in lockstep with `AssessmentMatch`. */
export const ASSESSMENT_ELEMENT_SCHEMA: ElementSchema = {
  type: 'object',
  properties: {
    exact: { type: 'string' },
    prefix: { type: 'string' },
    suffix: { type: 'string' },
    assessment: { type: 'string' },
  },
  required: ['exact', 'assessment'],
  additionalProperties: false,
};

/**
 * Represents a detected tag with validated position
 */
export interface TagMatch {
  exact: string;
  start: number;
  end: number;
  prefix?: string;
  suffix?: string;
  category: string;
}

/**
 * Wire schema for one tag element — keep in lockstep with `RawTagInput`
 * (the category is stamped by the caller, not emitted by the model).
 */
export const TAG_ELEMENT_SCHEMA: ElementSchema = {
  type: 'object',
  properties: {
    exact: { type: 'string' },
    prefix: { type: 'string' },
    suffix: { type: 'string' },
  },
  required: ['exact'],
  additionalProperties: false,
};

/**
 * What anchoring a chunk's proposals yields: the spans found in the text, and
 * how many proposed ones were not. The second is counted because a job reports
 * it (`errors`); dropped in silence, the job's `found` would be what survived.
 */
export interface Anchored<T> {
  matches: T[];
  dropped: number;
}

export class MotivationParsers {
  /**
   * Validate and reconcile structured comment elements.
   *
   * @param parsed - Already-parsed elements from the structured surface
   * @param content - Original content to validate offsets against
   * @returns The comments anchored in the content, and how many were not
   */
  static parseComments(parsed: unknown[], content: string, offsets: TextOffsets, logger: Logger): Anchored<CommentMatch> {

    const valid = parsed.filter((c): c is { exact: string; prefix?: string; suffix?: string; comment: string } =>
      isObject(c) &&
      isString(c.exact) &&
      isString(c.comment) &&
      c.comment.trim().length > 0
    );

    logger.debug('Read the proposals of a reply', { motivation: 'commenting', proposals: valid.length, elements: parsed.length });

    const validatedComments: CommentMatch[] = [];
    for (const comment of valid) {
      const reconciled = reconcileSelector(content, offsets, {
        exact: comment.exact,
        ...(typeof comment.prefix === 'string' ? { prefix: comment.prefix } : {}),
        ...(typeof comment.suffix === 'string' ? { suffix: comment.suffix } : {}),
      });
      if (!reconciled) {
        logger.warn('Proposal dropped — text not found in source', { motivation: 'commenting', text: comment.exact });
        continue;
      }
      noteAnchor('comment', comment.exact, reconciled.anchorMethod, logger);
      validatedComments.push({
        comment: comment.comment,
        exact: reconciled.exact,
        start: reconciled.start,
        end: reconciled.end,
        ...(reconciled.prefix !== undefined ? { prefix: reconciled.prefix } : {}),
        ...(reconciled.suffix !== undefined ? { suffix: reconciled.suffix } : {}),
      });
    }

    return { matches: validatedComments, dropped: valid.length - validatedComments.length };
  }

  /**
   * Validate and reconcile structured highlight elements.
   *
   * @param parsed - Already-parsed elements from the structured surface
   * @param content - Original content to validate offsets against
   * @returns The highlights anchored in the content, and how many were not
   */
  static parseHighlights(parsed: unknown[], content: string, offsets: TextOffsets, logger: Logger): Anchored<HighlightMatch> {

    const highlights = parsed.filter((h): h is { exact: string; prefix?: string; suffix?: string } =>
      isObject(h) && isString(h.exact)
    );

    const validatedHighlights: HighlightMatch[] = [];
    for (const highlight of highlights) {
      const reconciled = reconcileSelector(content, offsets, {
        exact: highlight.exact,
        ...(typeof highlight.prefix === 'string' ? { prefix: highlight.prefix } : {}),
        ...(typeof highlight.suffix === 'string' ? { suffix: highlight.suffix } : {}),
      });
      if (!reconciled) {
        logger.warn('Proposal dropped — text not found in source', { motivation: 'highlighting', text: highlight.exact });
        continue;
      }
      noteAnchor('highlight', highlight.exact, reconciled.anchorMethod, logger);
      validatedHighlights.push({
        exact: reconciled.exact,
        start: reconciled.start,
        end: reconciled.end,
        ...(reconciled.prefix !== undefined ? { prefix: reconciled.prefix } : {}),
        ...(reconciled.suffix !== undefined ? { suffix: reconciled.suffix } : {}),
      });
    }

    return { matches: validatedHighlights, dropped: highlights.length - validatedHighlights.length };
  }

  /**
   * Validate and reconcile structured assessment elements.
   *
   * @param parsed - Already-parsed elements from the structured surface
   * @param content - Original content to validate offsets against
   * @returns The assessments anchored in the content, and how many were not
   */
  static parseAssessments(parsed: unknown[], content: string, offsets: TextOffsets, logger: Logger): Anchored<AssessmentMatch> {

    // A blank assessment says nothing, as a blank comment says nothing: its
    // element is no proposal.
    const assessments = parsed.filter((a): a is { exact: string; prefix?: string; suffix?: string; assessment: string } =>
      isObject(a) &&
      isString(a.exact) &&
      isString(a.assessment) &&
      a.assessment.trim().length > 0
    );

    const validatedAssessments: AssessmentMatch[] = [];
    for (const assessment of assessments) {
      const reconciled = reconcileSelector(content, offsets, {
        exact: assessment.exact,
        ...(typeof assessment.prefix === 'string' ? { prefix: assessment.prefix } : {}),
        ...(typeof assessment.suffix === 'string' ? { suffix: assessment.suffix } : {}),
      });
      if (!reconciled) {
        logger.warn('Proposal dropped — text not found in source', { motivation: 'assessing', text: assessment.exact });
        continue;
      }
      noteAnchor('assessment', assessment.exact, reconciled.anchorMethod, logger);
      validatedAssessments.push({
        assessment: assessment.assessment,
        exact: reconciled.exact,
        start: reconciled.start,
        end: reconciled.end,
        ...(reconciled.prefix !== undefined ? { prefix: reconciled.prefix } : {}),
        ...(reconciled.suffix !== undefined ? { suffix: reconciled.suffix } : {}),
      });
    }

    return { matches: validatedAssessments, dropped: assessments.length - validatedAssessments.length };
  }

  /**
   * Validate structured tag elements into raw, pre-reconciliation tag inputs.
   * Reconciliation happens in `validateTagOffsets`, which adds `start`/`end`
   * by anchoring `exact` against the source content. An `exact` of no
   * characters is a proposal like any other, as it is for every motivation:
   * it is anchored nowhere, and counted there.
   *
   * @param parsed - Already-parsed elements from the structured surface
   */
  static parseTags(parsed: unknown[], logger: Logger): RawTagInput[] {

    const valid = parsed.filter((t): t is RawTagInput =>
      isObject(t) && isString(t.exact)
    );

    logger.debug('Read the proposals of a reply', { motivation: 'tagging', proposals: valid.length, elements: parsed.length });

    return valid;
  }

  /**
   * Anchor raw tag inputs against source content and add category.
   */
  static validateTagOffsets(
    tags: RawTagInput[],
    content: string,
    offsets: TextOffsets,
    category: string,
    logger: Logger,
  ): Anchored<TagMatch> {
    const validatedTags: TagMatch[] = [];
    for (const tag of tags) {
      const reconciled = reconcileSelector(content, offsets, {
        exact: tag.exact,
        ...(typeof tag.prefix === 'string' ? { prefix: tag.prefix } : {}),
        ...(typeof tag.suffix === 'string' ? { suffix: tag.suffix } : {}),
      });
      if (!reconciled) {
        logger.warn('Proposal dropped — text not found in source', { motivation: 'tagging', category, text: tag.exact });
        continue;
      }
      noteAnchor('tag', tag.exact, reconciled.anchorMethod, logger);
      validatedTags.push({
        category,
        exact: reconciled.exact,
        start: reconciled.start,
        end: reconciled.end,
        ...(reconciled.prefix !== undefined ? { prefix: reconciled.prefix } : {}),
        ...(reconciled.suffix !== undefined ? { suffix: reconciled.suffix } : {}),
      });
    }
    return { matches: validatedTags, dropped: tags.length - validatedTags.length };
  }
}

/** Raw LLM-emitted tag, pre-reconciliation. */
export interface RawTagInput {
  exact: string;
  prefix?: string;
  suffix?: string;
}
