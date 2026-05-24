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

import { reconcileSelector, type AnchorMethod } from '@semiont/core';
/**
 * Best-effort extractor that pulls a JSON array of objects out of a raw
 * LLM response. Tolerates:
 *   - markdown code fences (``` / ```json)
 *   - prose before/after the array
 *   - stray non-JSON tokens between array elements (a common
 *     hallucination: e.g. a line like `wide: 0,` inserted between two
 *     well-formed objects).
 *
 * Strategy: try strict `JSON.parse` first (fast path); on failure, walk
 * between the outermost `[` and `]` and parse each balanced `{ ... }`
 * object independently, skipping any that don't parse. Returns the
 * recovered objects — callers should still filter/validate fields.
 *
 * Exported for direct unit testing of the state machine edge cases
 * (nested braces in strings, escape sequences, empty/garbage input).
 */
export function extractObjectsFromArray(response: string): unknown[] {
  let cleaned = response.trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Fast path: well-formed JSON
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // fall through to tolerant parse
  }

  // Tolerant path: extract each top-level `{ ... }` from within the
  // first `[` / last `]`, parse independently. If the response was
  // truncated mid-stream (no closing `]`), fall back to end-of-string
  // so we still recover whatever closed cleanly before the cutoff.
  const start = cleaned.indexOf('[');
  if (start === -1) return [];
  const endBracket = cleaned.lastIndexOf(']');
  const end = endBracket > start ? endBracket : cleaned.length;

  const inner = cleaned.slice(start + 1, end);
  const objects: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try {
          objects.push(JSON.parse(inner.slice(objStart, i + 1)));
        } catch {
          // Skip malformed object
        }
        objStart = -1;
      }
    }
  }

  return objects;
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
   * @param response - Raw AI response string (may include markdown code fences)
   * @param content - Original content to validate offsets against
   * @returns Array of validated comment matches
   */
  static parseComments(response: string, content: string): CommentMatch[] {
    try {
      const parsed = extractObjectsFromArray(response);

      const valid = parsed.filter((c): c is { exact: string; prefix?: string; suffix?: string; comment: string } =>
        !!c && typeof c === 'object' &&
        typeof (c as any).exact === 'string' &&
        typeof (c as any).comment === 'string' &&
        (c as any).comment.trim().length > 0
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
    } catch (error) {
      console.error('[MotivationParsers] Failed to parse AI comment response:', error);
      return [];
    }
  }

  /**
   * Parse and validate AI response for highlight detection
   *
   * @param response - Raw AI response string (may include markdown code fences)
   * @param content - Original content to validate offsets against
   * @returns Array of validated highlight matches
   */
  static parseHighlights(response: string, content: string): HighlightMatch[] {
    try {
      const parsed = extractObjectsFromArray(response);

      const highlights = parsed.filter((h): h is { exact: string; prefix?: string; suffix?: string } =>
        !!h && typeof h === 'object' &&
        typeof (h as any).exact === 'string'
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
    } catch (error) {
      console.error('[MotivationParsers] Failed to parse AI highlight response:', error);
      console.error('Raw response:', response);
      return [];
    }
  }

  /**
   * Parse and validate AI response for assessment detection
   *
   * @param response - Raw AI response string (may include markdown code fences)
   * @param content - Original content to validate offsets against
   * @returns Array of validated assessment matches
   */
  static parseAssessments(response: string, content: string): AssessmentMatch[] {
    try {
      const parsed = extractObjectsFromArray(response);

      const assessments = parsed.filter((a): a is { exact: string; prefix?: string; suffix?: string; assessment: string } =>
        !!a && typeof a === 'object' &&
        typeof (a as any).exact === 'string' &&
        typeof (a as any).assessment === 'string'
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
    } catch (error) {
      console.error('[MotivationParsers] Failed to parse AI assessment response:', error);
      console.error('Raw response:', response);
      return [];
    }
  }

  /**
   * Parse the LLM's tag response into raw, pre-reconciliation tag inputs.
   * Reconciliation happens in `validateTagOffsets`, which adds `start`/`end`
   * by anchoring `exact` against the source content.
   */
  static parseTags(response: string): RawTagInput[] {
    try {
      const parsed = extractObjectsFromArray(response);

      const valid = parsed.filter((t): t is RawTagInput =>
        !!t && typeof t === 'object' &&
        typeof (t as any).exact === 'string' &&
        (t as any).exact.trim().length > 0
      );

      console.log(`[MotivationParsers] Parsed ${valid.length} valid tags from ${parsed.length} total`);

      return valid;
    } catch (error) {
      console.error('[MotivationParsers] Failed to parse AI tag response:', error);
      return [];
    }
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
