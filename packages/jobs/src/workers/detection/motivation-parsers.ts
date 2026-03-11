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

import { validateAndCorrectOffsets } from '@semiont/api-client';

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
      // Clean up markdown code fences if present
      let cleaned = response.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(parsed)) {
        console.warn('[MotivationParsers] Comment response is not an array');
        return [];
      }

      // Validate and filter
      const valid = parsed.filter((c: any) =>
        c &&
        typeof c.exact === 'string' &&
        typeof c.start === 'number' &&
        typeof c.end === 'number' &&
        typeof c.comment === 'string' &&
        c.comment.trim().length > 0
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
      // Clean up response - remove markdown code fences if present
      let cleaned = response.trim();
      if (cleaned.startsWith('```json') || cleaned.startsWith('```')) {
        cleaned = cleaned.slice(cleaned.indexOf('\n') + 1);
        const endIndex = cleaned.lastIndexOf('```');
        if (endIndex !== -1) {
          cleaned = cleaned.slice(0, endIndex);
        }
      }

      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) {
        console.warn('[MotivationParsers] Highlight response was not an array');
        return [];
      }

      // Validate and filter results
      const highlights = parsed.filter((h: any) =>
        h && typeof h.exact === 'string' &&
        typeof h.start === 'number' &&
        typeof h.end === 'number'
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
      // Clean up response - remove markdown code fences if present
      let cleaned = response.trim();
      if (cleaned.startsWith('```json') || cleaned.startsWith('```')) {
        cleaned = cleaned.slice(cleaned.indexOf('\n') + 1);
        const endIndex = cleaned.lastIndexOf('```');
        if (endIndex !== -1) {
          cleaned = cleaned.slice(0, endIndex);
        }
      }

      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) {
        console.warn('[MotivationParsers] Assessment response was not an array');
        return [];
      }

      // Validate and filter results
      const assessments = parsed.filter((a: any) =>
        a && typeof a.exact === 'string' &&
        typeof a.start === 'number' &&
        typeof a.end === 'number' &&
        typeof a.assessment === 'string'
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
      // Clean up markdown code fences if present
      let cleaned = response.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(parsed)) {
        console.warn('[MotivationParsers] Tag response is not an array');
        return [];
      }

      // Validate and filter
      const valid = parsed.filter((t: any) =>
        t &&
        typeof t.exact === 'string' &&
        typeof t.start === 'number' &&
        typeof t.end === 'number' &&
        t.exact.trim().length > 0
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
