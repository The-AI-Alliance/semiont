import { getInferenceClient, getInferenceModel } from './factory';

/**
 * Entity reference extracted from text
 */
export interface ExtractedEntity {
  text: string;           // The actual text span
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
  text: string,
  entityTypes: string[] | { type: string; examples?: string[] }[]
): Promise<ExtractedEntity[]> {
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
${text}
"""

Return ONLY a JSON array of entities found. Each entity should have:
- text: the exact text span from the input
- entityType: one of the provided entity types
- startOffset: character position where the entity starts (0-indexed)
- endOffset: character position where the entity ends

Return empty array [] if no entities found.
Do not include markdown formatting or code fences, just the raw JSON array.

Example output:
[{"text":"Alice","entityType":"Person","startOffset":0,"endOffset":5},{"text":"Paris","entityType":"Location","startOffset":20,"endOffset":25}]`;

  const response = await client.messages.create({
    model: getInferenceModel(),
    max_tokens: 1000,
    temperature: 0.3, // Lower temperature for more consistent extraction
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  const textContent = response.content.find(c => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    return [];
  }

  try {
    // Clean up response if wrapped in markdown
    let jsonStr = textContent.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const entities = JSON.parse(jsonStr);

    // Validate and fix offsets
    return entities.map((entity: any) => {
      let startOffset = entity.startOffset;
      let endOffset = entity.endOffset;

      // Verify the offsets are correct by checking if the text matches
      const extractedText = text.substring(startOffset, endOffset);

      // If the extracted text doesn't match, find the correct position
      if (extractedText !== entity.text) {
        const index = text.indexOf(entity.text);
        if (index !== -1) {
          startOffset = index;
          endOffset = index + entity.text.length;
        } else {
          // If we still can't find it, skip this entity
          return null;
        }
      }

      return {
        text: entity.text,
        entityType: entity.entityType,
        startOffset: startOffset,
        endOffset: endOffset
      };
    }).filter((entity: ExtractedEntity | null): entity is ExtractedEntity =>
      // Filter out nulls and ensure we have valid offsets
      entity !== null &&
      entity.startOffset !== undefined &&
      entity.endOffset !== undefined &&
      entity.startOffset >= 0 &&
      entity.endOffset <= text.length &&
      // Verify the text at the offsets matches
      text.substring(entity.startOffset, entity.endOffset) === entity.text
    );
  } catch (error) {
    console.error('Failed to parse entity extraction response:', error);
    return [];
  }
}