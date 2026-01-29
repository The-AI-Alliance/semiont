import type { InferenceClient } from '@semiont/inference';

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
 * @returns Array of extracted entities with their character offsets
 */
export async function extractEntities(
  exact: string,
  entityTypes: string[] | { type: string; examples?: string[] }[],
  client: InferenceClient,
  includeDescriptiveReferences: boolean = false
): Promise<ExtractedEntity[]> {
  console.log('extractEntities called with:', {
    textLength: exact.length,
    entityTypes: Array.isArray(entityTypes) ? entityTypes.map(et => typeof et === 'string' ? et : et.type) : []
  });

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

Return ONLY a JSON array of entities found. Each entity should have:
- exact: the exact text span from the input
- entityType: one of the provided entity types
- startOffset: character position where the entity starts (0-indexed)
- endOffset: character position where the entity ends
- prefix: up to 32 characters of text immediately before the entity (helps identify correct occurrence)
- suffix: up to 32 characters of text immediately after the entity (helps identify correct occurrence)

Return empty array [] if no entities found.
Do not include markdown formatting or code fences, just the raw JSON array.

Example output:
[{"exact":"Alice","entityType":"Person","startOffset":0,"endOffset":5,"prefix":"","suffix":" went to"},{"exact":"Paris","entityType":"Location","startOffset":20,"endOffset":25,"prefix":"went to ","suffix":" yesterday"}]`;

  console.log('Sending entity extraction request');
  const response = await client.generateTextWithMetadata(
    prompt,
    4000, // Increased to handle many entities without truncation
    0.3   // Lower temperature for more consistent extraction
  );
  console.log('Got entity extraction response');

  console.log('Entity extraction raw response length:', response.text.length);

  try {
    // Clean up response if wrapped in markdown
    let jsonStr = response.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const entities = JSON.parse(jsonStr);
    console.log('Parsed', entities.length, 'entities from response');

    // Check if response was truncated - this is an ERROR condition
    if (response.stopReason === 'max_tokens') {
      const errorMsg = `AI response truncated: Found ${entities.length} entities but response hit max_tokens limit. Increase max_tokens or reduce resource size.`;
      console.error(`❌ ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // Validate and fix offsets
    return entities.map((entity: any, idx: number) => {
      let startOffset = entity.startOffset;
      let endOffset = entity.endOffset;

      console.log(`\n[Entity ${idx + 1}/${entities.length}]`);
      console.log(`  Type: ${entity.entityType}`);
      console.log(`  Text: "${entity.exact}"`);
      console.log(`  Offsets from AI: [${startOffset}, ${endOffset}]`);

      // Verify the offsets are correct by checking if the text matches
      const extractedText = exact.substring(startOffset, endOffset);

      // If the extracted text doesn't match, find the correct position using context
      if (extractedText !== entity.exact) {
        console.log(`  ⚠️  Offset mismatch!`);
        console.log(`  Expected: "${entity.exact}"`);
        console.log(`  Found at AI offsets [${startOffset}:${endOffset}]: "${extractedText}"`);

        // Show context around the AI-provided offset
        const contextStart = Math.max(0, startOffset - 50);
        const contextEnd = Math.min(exact.length, endOffset + 50);
        const contextBefore = exact.substring(contextStart, startOffset);
        const contextAfter = exact.substring(endOffset, contextEnd);
        console.log(`  Context: "...${contextBefore}[${extractedText}]${contextAfter}..."`);

        console.log(`  Searching for exact match in resource...`);

        // Try to find using prefix/suffix context if provided
        let found = false;
        if (entity.prefix || entity.suffix) {
          console.log(`  Using LLM-provided context for disambiguation:`);
          if (entity.prefix) console.log(`    Prefix: "${entity.prefix}"`);
          if (entity.suffix) console.log(`    Suffix: "${entity.suffix}"`);

          // Search for all occurrences and find the one with matching context
          let searchPos = 0;
          while ((searchPos = exact.indexOf(entity.exact, searchPos)) !== -1) {
            const candidatePrefix = exact.substring(Math.max(0, searchPos - 32), searchPos);
            const candidateSuffix = exact.substring(
              searchPos + entity.exact.length,
              Math.min(exact.length, searchPos + entity.exact.length + 32)
            );

            // Check if context matches (allowing for partial matches at boundaries)
            const prefixMatch = !entity.prefix || candidatePrefix.endsWith(entity.prefix);
            const suffixMatch = !entity.suffix || candidateSuffix.startsWith(entity.suffix);

            if (prefixMatch && suffixMatch) {
              console.log(`  ✅ Found match using context at offset ${searchPos} (diff: ${searchPos - startOffset})`);
              console.log(`    Candidate prefix: "${candidatePrefix}"`);
              console.log(`    Candidate suffix: "${candidateSuffix}"`);
              startOffset = searchPos;
              endOffset = searchPos + entity.exact.length;
              found = true;
              break;
            }

            searchPos++;
          }

          if (!found) {
            console.log(`  ⚠️  No occurrence found with matching context`);
          }
        }

        // Fallback to first occurrence if context didn't help
        if (!found) {
          const index = exact.indexOf(entity.exact);
          if (index !== -1) {
            console.log(`  ⚠️  Using first occurrence at offset ${index} (diff: ${index - startOffset})`);
            startOffset = index;
            endOffset = index + entity.exact.length;
          } else {
            console.log(`  ❌ Cannot find "${entity.exact}" anywhere in resource`);
            console.log(`  Resource starts with: "${exact.substring(0, 200)}..."`);
            // If we still can't find it, skip this entity
            return null;
          }
        }
      } else {
        console.log(`  ✅ Offsets correct`);
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
        console.log('❌ Filtered entity: null');
        return false;
      }
      if (entity.startOffset === undefined || entity.endOffset === undefined) {
        console.log(`❌ Filtered entity "${entity.exact}": missing offsets`);
        return false;
      }
      if (entity.startOffset < 0) {
        console.log(`❌ Filtered entity "${entity.exact}": negative startOffset (${entity.startOffset})`);
        return false;
      }
      if (entity.endOffset > exact.length) {
        console.log(`❌ Filtered entity "${entity.exact}": endOffset (${entity.endOffset}) > text length (${exact.length})`);
        return false;
      }

      // Verify the text at the offsets matches
      const extractedText = exact.substring(entity.startOffset, entity.endOffset);
      if (extractedText !== entity.exact) {
        console.log(`❌ Filtered entity "${entity.exact}": offset mismatch`);
        console.log(`   Expected: "${entity.exact}"`);
        console.log(`   Got at [${entity.startOffset}:${entity.endOffset}]: "${extractedText}"`);
        return false;
      }

      console.log(`✅ Accepted entity "${entity.exact}" at [${entity.startOffset}:${entity.endOffset}]`);
      return true;
    });
  } catch (error) {
    console.error('Failed to parse entity extraction response:', error);
    return [];
  }
}