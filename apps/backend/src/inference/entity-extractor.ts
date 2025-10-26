import { getInferenceClient, getInferenceModel } from './factory';

/**
 * Entity reference extracted from text
 */
export interface ExtractedEntity {
  exact: string;           // The actual text span
  entityType: string;     // The detected entity type
  startOffset: number;    // Character offset where entity starts
  endOffset: number;      // Character offset where entity ends
}

/**
 * Extract entity references from text using AI
 *
 * @param text - The text to analyze
 * @param entityTypes - Array of entity types to detect (optionally with examples)
 * @returns Array of extracted entities with their character offsets
 */
export async function extractEntities(
  exact: string,
  entityTypes: string[] | { type: string; examples?: string[] }[]
): Promise<ExtractedEntity[]> {
  console.log('extractEntities called with:', {
    textLength: exact.length,
    entityTypes: Array.isArray(entityTypes) ? entityTypes.map(et => typeof et === 'string' ? et : et.type) : []
  });

  const client = await getInferenceClient();

  // Format entity types for the prompt
  const entityTypesDescription = entityTypes.map(et => {
    if (typeof et === 'string') {
      return et;
    }
    return et.examples && et.examples.length > 0
      ? `${et.type} (examples: ${et.examples.slice(0, 3).join(', ')})`
      : et.type;
  }).join(', ');

  const prompt = `Identify entity references in the following text. Look for mentions of: ${entityTypesDescription}.

Text to analyze:
"""
${exact}
"""

Return ONLY a JSON array of entities found. Each entity should have:
- exact: the exact text span from the input
- entityType: one of the provided entity types
- startOffset: character position where the entity starts (0-indexed)
- endOffset: character position where the entity ends

Return empty array [] if no entities found.
Do not include markdown formatting or code fences, just the raw JSON array.

Example output:
[{"exact":"Alice","entityType":"Person","startOffset":0,"endOffset":5},{"exact":"Paris","entityType":"Location","startOffset":20,"endOffset":25}]`;

  console.log('Sending entity extraction request to model:', getInferenceModel());
  const response = await client.messages.create({
    model: getInferenceModel(),
    max_tokens: 4000, // Increased to handle many entities without truncation
    temperature: 0.3, // Lower temperature for more consistent extraction
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  });
  console.log('Got entity extraction response');

  const textContent = response.content.find(c => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    console.warn('No text content in entity extraction response');
    return [];
  }

  console.log('Entity extraction raw response length:', textContent.text.length);

  try {
    // Clean up response if wrapped in markdown
    let jsonStr = textContent.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const entities = JSON.parse(jsonStr);
    console.log('Parsed', entities.length, 'entities from response');

    // Check if response was truncated - this is an ERROR condition
    if (response.stop_reason === 'max_tokens') {
      const errorMsg = `AI response truncated: Found ${entities.length} entities but response hit max_tokens limit. Increase max_tokens or reduce document size.`;
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

      // If the extracted text doesn't match, find the correct position
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

        console.log(`  Searching for exact match in document...`);
        const index = exact.indexOf(entity.exact);
        if (index !== -1) {
          console.log(`  ✅ Found at offset ${index} (diff: ${index - startOffset})`);
          startOffset = index;
          endOffset = index + entity.exact.length;
        } else {
          console.log(`  ❌ Cannot find "${entity.exact}" anywhere in document`);
          console.log(`  Document starts with: "${exact.substring(0, 200)}..."`);
          // If we still can't find it, skip this entity
          return null;
        }
      } else {
        console.log(`  ✅ Offsets correct`);
      }

      return {
        exact: entity.exact,
        entityType: entity.entityType,
        startOffset: startOffset,
        endOffset: endOffset
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