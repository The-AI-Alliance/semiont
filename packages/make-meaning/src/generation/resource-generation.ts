/**
 * Resource Generation Functions
 *
 * Application-specific resource generation logic:
 * - Resource summary generation
 * - Reference suggestion generation
 *
 * NOTE: generateResourceFromTopic lives in @semiont/jobs (canonical location)
 * because make-meaning depends on jobs, not vice versa.
 */

import type { InferenceClient } from '@semiont/inference';

/**
 * Generate an intelligent summary for a resource
 */
export async function generateResourceSummary(
  resourceName: string,
  content: string,
  entityTypes: string[],
  client: InferenceClient
): Promise<string> {
  // Truncate content if too long
  const truncatedContent = content.length > 2000
    ? content.substring(0, 2000) + '...'
    : content;

  const prompt = `Create a brief, intelligent summary of this resource titled "${resourceName}".
${entityTypes.length > 0 ? `Key entity types: ${entityTypes.join(', ')}` : ''}

Resource content:
${truncatedContent}

Write a 2-3 sentence summary that captures the key points and would help someone understand what this resource contains.`;

  return await client.generateText(prompt, 150, 0.5);
}

/**
 * Generate smart suggestions for a reference
 */
export async function generateReferenceSuggestions(
  referenceTitle: string,
  client: InferenceClient,
  entityType?: string,
  currentContent?: string
): Promise<string[] | null> {
  const prompt = `For a reference titled "${referenceTitle}"${entityType ? ` (type: ${entityType})` : ''}${currentContent ? ` with current stub: "${currentContent}"` : ''}, suggest 3 specific, actionable next steps or related topics to explore.

Format as a simple list, one suggestion per line.`;

  const response = await client.generateText(prompt, 200, 0.8);
  if (!response) {
    return null;
  }

  // Parse into array of suggestions
  return response
    .split('\n')
    .map(line => line.replace(/^[-*•]\s*/, '').trim())
    .filter(line => line.length > 0)
    .slice(0, 3);
}
