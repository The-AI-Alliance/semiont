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

import { validateAndCorrectOffsets } from '@semiont/core';
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

      // Validate and filter
      const valid = parsed.filter((c): c is CommentMatch =>
        !!c && typeof c === 'object' &&
        typeof (c as any).exact === 'string' &&
        typeof (c as any).start === 'number' &&
        typeof (c as any).end === 'number' &&
        typeof (c as any).comment === 'string' &&
        (c as any).comment.trim().length > 0
      );

      console.log(`[MotivationParsers] Parsed ${valid.length} valid comments from ${parsed.length} total`);

      // Validate and correct AI's offsets, then extract proper context
      // AI sometimes returns offsets that don't match the actual text position
      const validatedComments: CommentMatch[] = [];

      for (const comment of valid) {
        try {
          const validated = validateAndCorrectOffsets(content, comment.start, comment.end, comment.exact);
          validatedComments.push({
            ...comment,
            start: validated.start,
            end: validated.end,
            prefix: validated.prefix,
            suffix: validated.suffix
          });
        } catch (error) {
          console.warn(`[MotivationParsers] Skipping invalid comment "${comment.exact}":`, error);
          // Skip this comment - AI hallucinated text that doesn't exist
        }
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

      // Validate and filter results
      const highlights = parsed.filter((h): h is HighlightMatch =>
        !!h && typeof h === 'object' &&
        typeof (h as any).exact === 'string' &&
        typeof (h as any).start === 'number' &&
        typeof (h as any).end === 'number'
      );

      // Validate and correct AI's offsets, then extract proper context
      // AI sometimes returns offsets that don't match the actual text position
      const validatedHighlights: HighlightMatch[] = [];

      for (const highlight of highlights) {
        try {
          const validated = validateAndCorrectOffsets(content, highlight.start, highlight.end, highlight.exact);
          validatedHighlights.push({
            ...highlight,
            start: validated.start,
            end: validated.end,
            prefix: validated.prefix,
            suffix: validated.suffix
          });
        } catch (error) {
          console.warn(`[MotivationParsers] Skipping invalid highlight "${highlight.exact}":`, error);
          // Skip this highlight - AI hallucinated text that doesn't exist
        }
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

      // Validate and filter results
      const assessments = parsed.filter((a): a is AssessmentMatch =>
        !!a && typeof a === 'object' &&
        typeof (a as any).exact === 'string' &&
        typeof (a as any).start === 'number' &&
        typeof (a as any).end === 'number' &&
        typeof (a as any).assessment === 'string'
      );

      // Validate and correct AI's offsets, then extract proper context
      // AI sometimes returns offsets that don't match the actual text position
      const validatedAssessments: AssessmentMatch[] = [];

      for (const assessment of assessments) {
        try {
          const validated = validateAndCorrectOffsets(content, assessment.start, assessment.end, assessment.exact);
          validatedAssessments.push({
            ...assessment,
            start: validated.start,
            end: validated.end,
            prefix: validated.prefix,
            suffix: validated.suffix
          });
        } catch (error) {
          console.warn(`[MotivationParsers] Skipping invalid assessment "${assessment.exact}":`, error);
          // Skip this assessment - AI hallucinated text that doesn't exist
        }
      }

      return validatedAssessments;
    } catch (error) {
      console.error('[MotivationParsers] Failed to parse AI assessment response:', error);
      console.error('Raw response:', response);
      return [];
    }
  }

  /**
   * Parse and validate AI response for tag detection
   * Note: Does NOT validate offsets - caller must do that with content
   *
   * @param response - Raw AI response string (may include markdown code fences)
   * @returns Array of tag matches (offsets not yet validated)
   */
  static parseTags(response: string): Omit<TagMatch, 'category'>[] {
    try {
      const parsed = extractObjectsFromArray(response);

      // Validate and filter
      const valid = parsed.filter((t): t is Omit<TagMatch, 'category'> =>
        !!t && typeof t === 'object' &&
        typeof (t as any).exact === 'string' &&
        typeof (t as any).start === 'number' &&
        typeof (t as any).end === 'number' &&
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
   * Validate tag offsets against content and add category
   * Helper for tag detection after initial parsing
   *
   * @param tags - Parsed tags without validated offsets
   * @param content - Original content to validate against
   * @param category - Category to assign to validated tags
   * @returns Array of validated tag matches
   */
  static validateTagOffsets(
    tags: Omit<TagMatch, 'category'>[],
    content: string,
    category: string
  ): TagMatch[] {
    const validatedTags: TagMatch[] = [];

    for (const tag of tags) {
      try {
        const validated = validateAndCorrectOffsets(content, tag.start, tag.end, tag.exact);
        validatedTags.push({
          ...tag,
          category,
          start: validated.start,
          end: validated.end,
          prefix: validated.prefix,
          suffix: validated.suffix
        });
      } catch (error) {
        console.warn(`[MotivationParsers] Skipping invalid tag for category "${category}":`, error);
        // Skip this tag - AI hallucinated text that doesn't exist
      }
    }

    return validatedTags;
  }
}
