/**
 * Response parsers for annotation detection motivations
 *
 * Provides static methods to parse and validate AI responses for each motivation type.
 * Includes offset validation and correction logic.
 * Extracted from worker implementations to centralize parsing logic.
 *
 * NOTE: These are static utility methods without logger access.
 * Console statements kept for debugging - consider adding logger parameter in future.
 */

import { reconcileSelector, isObject, isString, type AnchorMethod } from '@semiont/core';
import type { ElementSchema } from '@semiont/inference';

// Parsers receive ALREADY-PARSED elements (`unknown[]`) from the structured
// inference surface — `generateStructured` returns `T[]` or throws, so
// "could not read the model" never reaches this layer and there is no string
// to parse here (the former strict `parseJsonArray` moved into that contract,
// as the earlier tolerant walker moved into it before). What remains here is
// per-element structural validation (STRUCTURED-INFERENCE D5 — the last line
// on the Ollama path and the schema/type drift guard) plus reconciliation
// against the full document.
//
// Each element schema is declared ADJACENT to the Match interface it mirrors:
// the schema constrains the wire, the interface is what the code consumes,
// and nothing verifies they agree — adjacency is the drift guard.
// `prefix`/`suffix` stay OUT of `required` deliberately: requiring them turns
// "sometimes absent" into "always present, sometimes empty" (measured
// 2026-08-06), an anchoring-path change Phase 3 examines before anyone
// relies on it.

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

export class MotivationParsers {
  /**
   * Validate and reconcile structured comment elements.
   *
   * @param parsed - Already-parsed elements from the structured surface
   * @param content - Original content to validate offsets against
   * @returns Array of validated comment matches
   */
  static parseComments(parsed: unknown[], content: string): CommentMatch[] {

    const valid = parsed.filter((c): c is { exact: string; prefix?: string; suffix?: string; comment: string } =>
      isObject(c) &&
      isString(c.exact) &&
      isString(c.comment) &&
      c.comment.trim().length > 0
    );

    console.log(`[MotivationParsers] Parsed ${valid.length} valid comments from ${parsed.length} total`);

    const validatedComments: CommentMatch[] = [];
    for (const comment of valid) {
      const reconciled = reconcileSelector(content, {
        exact: comment.exact,
        ...(typeof comment.prefix === 'string' ? { prefix: comment.prefix } : {}),
        ...(typeof comment.suffix === 'string' ? { suffix: comment.suffix } : {}),
      });
      if (!reconciled) {
        console.warn(`[MotivationParsers] Dropped hallucinated comment "${comment.exact}"`);
        continue;
      }
      logAnchorMethod('comment', comment.exact, reconciled.anchorMethod);
      validatedComments.push({
        comment: comment.comment,
        exact: reconciled.exact,
        start: reconciled.start,
        end: reconciled.end,
        ...(reconciled.prefix !== undefined ? { prefix: reconciled.prefix } : {}),
        ...(reconciled.suffix !== undefined ? { suffix: reconciled.suffix } : {}),
      });
    }

    return validatedComments;
  }

  /**
   * Validate and reconcile structured highlight elements.
   *
   * @param parsed - Already-parsed elements from the structured surface
   * @param content - Original content to validate offsets against
   * @returns Array of validated highlight matches
   */
  static parseHighlights(parsed: unknown[], content: string): HighlightMatch[] {

    const highlights = parsed.filter((h): h is { exact: string; prefix?: string; suffix?: string } =>
      isObject(h) && isString(h.exact)
    );

    const validatedHighlights: HighlightMatch[] = [];
    for (const highlight of highlights) {
      const reconciled = reconcileSelector(content, {
        exact: highlight.exact,
        ...(typeof highlight.prefix === 'string' ? { prefix: highlight.prefix } : {}),
        ...(typeof highlight.suffix === 'string' ? { suffix: highlight.suffix } : {}),
      });
      if (!reconciled) {
        console.warn(`[MotivationParsers] Dropped hallucinated highlight "${highlight.exact}"`);
        continue;
      }
      logAnchorMethod('highlight', highlight.exact, reconciled.anchorMethod);
      validatedHighlights.push({
        exact: reconciled.exact,
        start: reconciled.start,
        end: reconciled.end,
        ...(reconciled.prefix !== undefined ? { prefix: reconciled.prefix } : {}),
        ...(reconciled.suffix !== undefined ? { suffix: reconciled.suffix } : {}),
      });
    }

    return validatedHighlights;
  }

  /**
   * Validate and reconcile structured assessment elements.
   *
   * @param parsed - Already-parsed elements from the structured surface
   * @param content - Original content to validate offsets against
   * @returns Array of validated assessment matches
   */
  static parseAssessments(parsed: unknown[], content: string): AssessmentMatch[] {

    const assessments = parsed.filter((a): a is { exact: string; prefix?: string; suffix?: string; assessment: string } =>
      isObject(a) && isString(a.exact) && isString(a.assessment)
    );

    const validatedAssessments: AssessmentMatch[] = [];
    for (const assessment of assessments) {
      const reconciled = reconcileSelector(content, {
        exact: assessment.exact,
        ...(typeof assessment.prefix === 'string' ? { prefix: assessment.prefix } : {}),
        ...(typeof assessment.suffix === 'string' ? { suffix: assessment.suffix } : {}),
      });
      if (!reconciled) {
        console.warn(`[MotivationParsers] Dropped hallucinated assessment "${assessment.exact}"`);
        continue;
      }
      logAnchorMethod('assessment', assessment.exact, reconciled.anchorMethod);
      validatedAssessments.push({
        assessment: assessment.assessment,
        exact: reconciled.exact,
        start: reconciled.start,
        end: reconciled.end,
        ...(reconciled.prefix !== undefined ? { prefix: reconciled.prefix } : {}),
        ...(reconciled.suffix !== undefined ? { suffix: reconciled.suffix } : {}),
      });
    }

    return validatedAssessments;
  }

  /**
   * Validate structured tag elements into raw, pre-reconciliation tag inputs.
   * Reconciliation happens in `validateTagOffsets`, which adds `start`/`end`
   * by anchoring `exact` against the source content.
   *
   * @param parsed - Already-parsed elements from the structured surface
   */
  static parseTags(parsed: unknown[]): RawTagInput[] {

    const valid = parsed.filter((t): t is RawTagInput =>
      isObject(t) && isString(t.exact) && t.exact.trim().length > 0
    );

    console.log(`[MotivationParsers] Parsed ${valid.length} valid tags from ${parsed.length} total`);

    return valid;
  }

  /**
   * Anchor raw tag inputs against source content and add category.
   */
  static validateTagOffsets(
    tags: RawTagInput[],
    content: string,
    category: string
  ): TagMatch[] {
    const validatedTags: TagMatch[] = [];
    for (const tag of tags) {
      const reconciled = reconcileSelector(content, {
        exact: tag.exact,
        ...(typeof tag.prefix === 'string' ? { prefix: tag.prefix } : {}),
        ...(typeof tag.suffix === 'string' ? { suffix: tag.suffix } : {}),
      });
      if (!reconciled) {
        console.warn(`[MotivationParsers] Dropped hallucinated tag "${tag.exact}" for category "${category}"`);
        continue;
      }
      logAnchorMethod('tag', tag.exact, reconciled.anchorMethod);
      validatedTags.push({
        category,
        exact: reconciled.exact,
        start: reconciled.start,
        end: reconciled.end,
        ...(reconciled.prefix !== undefined ? { prefix: reconciled.prefix } : {}),
        ...(reconciled.suffix !== undefined ? { suffix: reconciled.suffix } : {}),
      });
    }
    return validatedTags;
  }
}

/** Raw LLM-emitted tag, pre-reconciliation. */
export interface RawTagInput {
  exact: string;
  prefix?: string;
  suffix?: string;
}

/**
 * Single audit log for any anchor-method classification a parser produces.
 * `llm-exact` and `unique-match` are silent (the common path). The risky
 * cases — `first-of-many` (multiple occurrences with no usable context)
 * and `fuzzy-match` (recovered via case/whitespace/Levenshtein) — log
 * `warn` so corpus owners can audit them in worker output.
 */
function logAnchorMethod(motivation: string, exact: string, anchorMethod: AnchorMethod): void {
  if (anchorMethod === 'first-of-many' || anchorMethod === 'fuzzy-match') {
    console.warn(`[MotivationParsers] ${motivation} anchored via ${anchorMethod}: "${exact}"`);
  }
}
