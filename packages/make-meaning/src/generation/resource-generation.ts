/**
 * Resource Generation Functions
 *
 * Application-specific resource generation logic including:
 * - Markdown resource generation from topics
 * - Resource summary generation
 * - Reference suggestion generation
 * - Language handling and template processing
 */

import { getLocaleEnglishName } from '@semiont/api-client';
import type { GenerationContext } from '@semiont/api-client';
import type { EnvironmentConfig } from '@semiont/core';
import { generateText } from '@semiont/inference';

function getLanguageName(locale: string): string {
  return getLocaleEnglishName(locale) || locale;
}

/**
 * Generate resource content using inference
 */
export async function generateResourceFromTopic(
  topic: string,
  entityTypes: string[],
  config: EnvironmentConfig,
  userPrompt?: string,
  locale?: string,
  context?: GenerationContext,
  temperature?: number,
  maxTokens?: number
): Promise<{ title: string; content: string }> {
  console.log('generateResourceFromTopic called with:', {
    topic: topic.substring(0, 100),
    entityTypes,
    hasUserPrompt: !!userPrompt,
    locale,
    hasContext: !!context,
    temperature,
    maxTokens
  });

  const inferenceConfig = config.services.inference;
  const provider = inferenceConfig?.type || 'anthropic';
  console.log('Using provider:', provider, 'with model:', inferenceConfig?.model);

  // Use provided values or defaults
  const finalTemperature = temperature ?? 0.7;
  const finalMaxTokens = maxTokens ?? 500;

  // Determine language instruction
  const languageInstruction = locale && locale !== 'en'
    ? `\n\nIMPORTANT: Write the entire resource in ${getLanguageName(locale)}.`
    : '';

  // Build context section if available
  let contextSection = '';
  if (context?.sourceContext) {
    const { before, selected, after } = context.sourceContext;
    contextSection = `\n\nSource document context:
---
${before ? `...${before}` : ''}
**[${selected}]**
${after ? `${after}...` : ''}
---
`;
  }

  // Simple, direct prompt - just ask for markdown content
  const prompt = `Generate a concise, informative resource about "${topic}".
${entityTypes.length > 0 ? `Focus on these entity types: ${entityTypes.join(', ')}.` : ''}
${userPrompt ? `Additional context: ${userPrompt}` : ''}${contextSection}${languageInstruction}

Requirements:
- Start with a clear heading (# Title)
- Write 2-3 paragraphs of substantive content
- Be factual and informative
- Use markdown formatting
- Return ONLY the markdown content, no JSON, no code fences, no additional wrapper`;

  // Simple parser - just use the response directly as markdown
  const parseResponse = (response: string): { title: string; content: string } => {
    // Clean up any markdown code fences if present
    let content = response.trim();
    if (content.startsWith('```markdown') || content.startsWith('```md')) {
      content = content.slice(content.indexOf('\n') + 1);
      const endIndex = content.lastIndexOf('```');
      if (endIndex !== -1) {
        content = content.slice(0, endIndex);
      }
    } else if (content.startsWith('```')) {
      content = content.slice(3);
      const endIndex = content.lastIndexOf('```');
      if (endIndex !== -1) {
        content = content.slice(0, endIndex);
      }
    }

    content = content.trim();

    // Title is provided by the caller (topic), not extracted from generated content
    // This matches how it's actually used in generation-worker.ts line 87
    return {
      title: topic,
      content: content
    };
  };

  console.log('Sending prompt to inference (length:', prompt.length, 'chars)', 'temp:', finalTemperature, 'maxTokens:', finalMaxTokens);
  const response = await generateText(prompt, config, finalMaxTokens, finalTemperature);
  console.log('Got raw response (length:', response.length, 'chars)');

  const result = parseResponse(response);
  console.log('Parsed result:', {
    hasTitle: !!result.title,
    titleLength: result.title?.length,
    hasContent: !!result.content,
    contentLength: result.content?.length
  });

  return result;
}

/**
 * Generate an intelligent summary for a resource
 */
export async function generateResourceSummary(
  resourceName: string,
  content: string,
  entityTypes: string[],
  config: EnvironmentConfig
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

  return await generateText(prompt, config, 150, 0.5);
}

/**
 * Generate smart suggestions for a reference
 */
export async function generateReferenceSuggestions(
  referenceTitle: string,
  config: EnvironmentConfig,
  entityType?: string,
  currentContent?: string
): Promise<string[] | null> {
  const prompt = `For a reference titled "${referenceTitle}"${entityType ? ` (type: ${entityType})` : ''}${currentContent ? ` with current stub: "${currentContent}"` : ''}, suggest 3 specific, actionable next steps or related topics to explore.

Format as a simple list, one suggestion per line.`;

  const response = await generateText(prompt, config, 200, 0.8);
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
