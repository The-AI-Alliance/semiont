import type { InferenceClient } from '@semiont/inference';
import type { Logger } from '@semiont/core';

/**
 * Entity reference extracted from text
 */
export interface ExtractedEntity {
  exact: string;           // The actual text span
  entityType: string;     // The detected entity type
  startOffset: number;    // Character offset where entity starts
  endOffset: number;      // Character offset where entity ends
  prefix?: string;        // Text immediately before entity (for disambiguation)
  suffix?: string;        // Text immediately after entity (for disambiguation)
}

/**
 * Extract entity references from text using AI
 *
 * @param text - The text to analyze
 * @param entityTypes - Array of entity types to detect (optionally with examples)
 * @param client - Inference client for AI operations
 * @param includeDescriptiveReferences - Include anaphoric/cataphoric references (default: false)
 * @param logger - Optional logger for debugging entity extraction
 * @returns Array of extracted entities with their character offsets
 */
export async function extractEntities(
  exact: string,
  entityTypes: string[] | { type: string; examples?: string[] }[],
  client: InferenceClient,
  includeDescriptiveReferences: boolean = false,
  logger?: Logger
): Promise<ExtractedEntity[]> {

  // Format entity types for the prompt
  const entityTypesDescription = entityTypes.map(et => {
    if (typeof et === 'string') {
      return et;
    }
    return et.examples && et.examples.length > 0
      ? `${et.type} (examples: ${et.examples.slice(0, 3).join(', ')})`
      : et.type;
  }).join(', ');

  // Build prompt with optional support for anaphoric/cataphoric references
  // Anaphora: references that point backward (e.g., "John arrived. He was tired.")
  // Cataphora: references that point forward (e.g., "When she arrived, Mary was surprised.")
  // When enabled, include substantive descriptive references beyond simple pronouns
  const descriptiveReferenceGuidance = includeDescriptiveReferences
    ? `
Include both:
- Direct mentions (names, proper nouns)
- Descriptive references (substantive phrases that refer to entities)

For descriptive references, include:
- Definite descriptions: "the Nobel laureate", "the tech giant", "the former president"
- Role-based references: "the CEO", "the physicist", "the author", "the owner", "the contractor"
- Epithets with context: "the Cupertino-based company", "the iPhone maker"
- References to entities even when identity is unknown or unspecified

Do NOT include:
- Simple pronouns alone: he, she, it, they, him, her, them
- Generic determiners alone: this, that, these, those
- Possessives without substance: his, her, their, its

Examples:
- For "Marie Curie", include "the Nobel laureate" and "the physicist" but NOT "she"
- For an unknown person, include "the owner" or "the contractor" (role-based references count even when identity is unspecified)
`
    : `
Find direct mentions only (names, proper nouns). Do not include pronouns or descriptive references.
`;

  const prompt = `Identify entity references in the following text. Look for mentions of: ${entityTypesDescription}.
${descriptiveReferenceGuidance}
Text to analyze:
"""
${exact}
"""

Respond with a JSON array of entities found. Each entity should have:
- exact: the exact text span from the input
- entityType: one of the provided entity types
- startOffset: character position where the entity starts (0-indexed)
- endOffset: character position where the entity ends
- prefix: up to 32 characters of text immediately before the entity (helps identify correct occurrence)
- suffix: up to 32 characters of text immediately after the entity (helps identify correct occurrence)

If no entities are found, respond with an empty array [].

Example output:
[{"exact":"Alice","entityType":"Person","startOffset":0,"endOffset":5,"prefix":"","suffix":" went to"},{"exact":"Paris","entityType":"Location","startOffset":20,"endOffset":25,"prefix":"went to ","suffix":" yesterday"}]`;

  logger?.debug('Sending entity extraction request', { entityTypes: entityTypesDescription });
  const response = await client.generateTextWithMetadata(
    prompt,
    4000, // Increased to handle many entities without truncation
    0.3   // Lower temperature for more consistent extraction
  );
  logger?.debug('Got entity extraction response', { responseLength: response.text.length });

  try {
    // Clean up response if wrapped in markdown
    let jsonStr = response.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const entities = JSON.parse(jsonStr);
    logger?.debug('Parsed entities from AI response', { count: entities.length });

    // Check if response was truncated - this is an ERROR condition
    if (response.stopReason === 'max_tokens') {
      const errorMsg = `AI response truncated: Found ${entities.length} entities but response hit max_tokens limit. Increase max_tokens or reduce resource size.`;
      logger?.error(errorMsg);
      throw new Error(errorMsg);
    }

    // Validate and fix offsets
    return entities.map((entity: any, idx: number) => {
      let startOffset = entity.startOffset;
      let endOffset = entity.endOffset;

      logger?.debug('Processing entity', {
        index: idx + 1,
        total: entities.length,
        type: entity.entityType,
        text: entity.exact,
        offsetsFromAI: `[${startOffset}:${endOffset}]`
      });

      // Verify the LLM-provided offsets point at the text the LLM says they do.
      //
      // Re-anchoring classification:
      //   'llm-exact'       — LLM offsets match `exact` on the first try (happy path)
      //   'context-recovered' — mismatch recovered via prefix/suffix disambiguation
      //   'unique-match'    — mismatch recovered by first-occurrence, but `exact`
      //                       appears exactly once so there's no ambiguity
      //   'first-of-many'   — mismatch fell back to first-occurrence while `exact`
      //                       appears multiple times — the annotation *may* be
      //                       anchored at the wrong occurrence
      //   'dropped'         — `exact` doesn't appear anywhere; entity skipped
      //
      // Log severity is tuned so that normal operation is silent at info/warn
      // level. Only 'first-of-many' warns (it's genuinely risky) and 'dropped'
      // errors (the LLM emitted something that isn't in the text).
      const extractedText = exact.substring(startOffset, endOffset);
      let anchorMethod: 'llm-exact' | 'context-recovered' | 'unique-match' | 'first-of-many' | 'dropped';

      if (extractedText === entity.exact) {
        anchorMethod = 'llm-exact';
        logger?.debug('Entity anchored', {
          text: entity.exact,
          entityType: entity.entityType,
          anchorMethod,
        });
      } else {
        // LLM offsets are wrong — the text at [start, end] isn't what they said.
        // Try to recover via prefix/suffix context, then by unique/first occurrence.
        logger?.debug('LLM offsets mismatch — attempting re-anchor', {
          expected: entity.exact,
          llmOffsets: `[${startOffset}:${endOffset}]`,
          foundAtLlmOffsets: extractedText,
        });

        // Count total occurrences up front — needed for the 'unique-match' vs
        // 'first-of-many' distinction below.
        let occurrenceCount = 0;
        let firstOccurrence = -1;
        let searchPos = 0;
        while ((searchPos = exact.indexOf(entity.exact, searchPos)) !== -1) {
          if (firstOccurrence === -1) firstOccurrence = searchPos;
          occurrenceCount++;
          searchPos++;
        }

        if (occurrenceCount === 0) {
          anchorMethod = 'dropped';
          logger?.error('Entity text not found in resource — dropping', {
            text: entity.exact,
            entityType: entity.entityType,
            llmOffsets: `[${startOffset}:${endOffset}]`,
            anchorMethod,
            resourceStart: exact.substring(0, 200),
          });
          return null;
        }

        // Try prefix/suffix-guided re-anchoring if context was provided.
        let recoveredOffset = -1;
        if (entity.prefix || entity.suffix) {
          let p = 0;
          while ((p = exact.indexOf(entity.exact, p)) !== -1) {
            const candidatePrefix = exact.substring(Math.max(0, p - 32), p);
            const candidateSuffix = exact.substring(
              p + entity.exact.length,
              Math.min(exact.length, p + entity.exact.length + 32),
            );
            const prefixMatch = !entity.prefix || candidatePrefix.endsWith(entity.prefix);
            const suffixMatch = !entity.suffix || candidateSuffix.startsWith(entity.suffix);
            if (prefixMatch && suffixMatch) {
              recoveredOffset = p;
              break;
            }
            p++;
          }
        }

        if (recoveredOffset !== -1) {
          anchorMethod = 'context-recovered';
          startOffset = recoveredOffset;
          endOffset = recoveredOffset + entity.exact.length;
          logger?.debug('Entity anchored', {
            text: entity.exact,
            entityType: entity.entityType,
            anchorMethod,
            offsetDiff: recoveredOffset - entity.startOffset,
          });
        } else if (occurrenceCount === 1) {
          anchorMethod = 'unique-match';
          startOffset = firstOccurrence;
          endOffset = firstOccurrence + entity.exact.length;
          logger?.debug('Entity anchored', {
            text: entity.exact,
            entityType: entity.entityType,
            anchorMethod,
            offsetDiff: firstOccurrence - entity.startOffset,
          });
        } else {
          // Multiple candidates, no context to disambiguate — risky fallback.
          // We still emit the annotation but flag it so operators can review.
          anchorMethod = 'first-of-many';
          startOffset = firstOccurrence;
          endOffset = firstOccurrence + entity.exact.length;
          logger?.warn('Entity anchored at first of multiple occurrences — may be wrong', {
            text: entity.exact,
            entityType: entity.entityType,
            anchorMethod,
            occurrenceCount,
            chosenOffset: firstOccurrence,
            llmOffsets: `[${entity.startOffset}:${entity.endOffset}]`,
            hasPrefix: !!entity.prefix,
            hasSuffix: !!entity.suffix,
          });
        }
      }

      return {
        exact: entity.exact,
        entityType: entity.entityType,
        startOffset: startOffset,
        endOffset: endOffset,
        prefix: entity.prefix,
        suffix: entity.suffix
      };
    }).filter((entity: ExtractedEntity | null): entity is ExtractedEntity => {
      // Filter out nulls and ensure we have valid offsets
      if (entity === null) {
        logger?.debug('Filtered entity: null');
        return false;
      }
      if (entity.startOffset === undefined || entity.endOffset === undefined) {
        logger?.warn('Filtered entity: missing offsets', { text: entity.exact });
        return false;
      }
      if (entity.startOffset < 0) {
        logger?.warn('Filtered entity: negative startOffset', {
          text: entity.exact,
          startOffset: entity.startOffset
        });
        return false;
      }
      if (entity.endOffset > exact.length) {
        logger?.warn('Filtered entity: endOffset exceeds text length', {
          text: entity.exact,
          endOffset: entity.endOffset,
          textLength: exact.length
        });
        return false;
      }

      // Verify the text at the offsets matches
      const extractedText = exact.substring(entity.startOffset, entity.endOffset);
      if (extractedText !== entity.exact) {
        logger?.warn('Filtered entity: offset mismatch', {
          expected: entity.exact,
          got: extractedText,
          offsets: `[${entity.startOffset}:${entity.endOffset}]`
        });
        return false;
      }

      logger?.debug('Accepted entity', {
        text: entity.exact,
        offsets: `[${entity.startOffset}:${entity.endOffset}]`
      });
      return true;
    });
  } catch (error) {
    logger?.error('Failed to parse entity extraction response', {
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}