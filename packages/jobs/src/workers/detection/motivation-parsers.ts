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

/**
 * Strict parse of an LLM JSON-array response.
 *
 * Post-Phase-1 both providers emit syntactically-valid, fence-free JSON
 * arrays — Anthropic via forced structured tool-use, Ollama via
 * grammar-constrained sampling — so there is nothing to tolerate. A parse
 * failure, or a non-array, is a real failure and is surfaced as a throw so
 * the job fails loudly (`job:failed`) instead of silently returning zero
 * annotations. A legitimately-empty `[]` parses to an empty array (a success
 * with no matches).
 *
 * Replaces the former tolerant `extractObjectsFromArray` walker, deleted
 * along with the silent-drop policy it served.
 */
function parseJsonArray(response: string, motivation: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.trim());
  } catch (error) {
    console.error(`[MotivationParsers] Failed to parse AI ${motivation} response:`, error);
    console.error('Raw response:', response);
    throw error instanceof Error ? error : new Error(String(error));
  }
  if (!Array.isArray(parsed)) {
    console.error(`[MotivationParsers] Expected a JSON array for ${motivation} detection, got ${typeof parsed}:`, response);
    throw new Error(`Expected a JSON array for ${motivation} detection, got ${typeof parsed}`);
  }
  return parsed;
}

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

export class MotivationParsers {
  /**
   * Parse and validate AI response for comment detection
   *
   * @param response - Raw AI response text (a JSON array)
   * @param content - Original content to validate offsets against
   * @returns Array of validated comment matches
   * @throws if the response is not a parseable JSON array
   */
  static parseComments(response: string, content: string): CommentMatch[] {
    const parsed = parseJsonArray(response, 'comment');

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
   * Parse and validate AI response for highlight detection
   *
   * @param response - Raw AI response text (a JSON array)
   * @param content - Original content to validate offsets against
   * @returns Array of validated highlight matches
   * @throws if the response is not a parseable JSON array
   */
  static parseHighlights(response: string, content: string): HighlightMatch[] {
    const parsed = parseJsonArray(response, 'highlight');

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
   * Parse and validate AI response for assessment detection
   *
   * @param response - Raw AI response text (a JSON array)
   * @param content - Original content to validate offsets against
   * @returns Array of validated assessment matches
   * @throws if the response is not a parseable JSON array
   */
  static parseAssessments(response: string, content: string): AssessmentMatch[] {
    const parsed = parseJsonArray(response, 'assessment');

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
   * Parse the LLM's tag response into raw, pre-reconciliation tag inputs.
   * Reconciliation happens in `validateTagOffsets`, which adds `start`/`end`
   * by anchoring `exact` against the source content.
   *
   * @throws if the response is not a parseable JSON array
   */
  static parseTags(response: string): RawTagInput[] {
    const parsed = parseJsonArray(response, 'tag');

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
