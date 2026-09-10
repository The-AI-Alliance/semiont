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

  return client.generateText(prompt, 150, 0.5);
}

/**
 * Generate smart suggestions for a reference.
 *
 * Named parameters, deliberately (bugs/gather-ships-raw-pdf-bytes P2): two
 * positional `string`s let a caller splice an entire document into the
 * TITLE slot with tsc silent — which is exactly what happened. `title` is a
 * name; `stub` is optional short placeholder content and is bounded here so
 * no caller can turn the prompt into a document.
 */
const STUB_BOUND_CHARS = 500;

export async function generateReferenceSuggestions(
  reference: { title: string; entityType?: string; stub?: string },
  client: InferenceClient,
): Promise<string[] | null> {
  const { title, entityType } = reference;
  const stub = reference.stub?.slice(0, STUB_BOUND_CHARS);
  const prompt = `For a reference titled "${title}"${entityType ? ` (type: ${entityType})` : ''}${stub ? ` with current stub: "${stub}"` : ''}, suggest 3 specific, actionable next steps or related topics to explore.

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
