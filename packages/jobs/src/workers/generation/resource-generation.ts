/**
 * Resource Generation
 *
 * Generates markdown resources from topics using AI inference.
 */

import { getLocaleEnglishName } from '@semiont/api-client';
import type { YieldContext, Logger } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';


function getLanguageName(locale: string): string {
  return getLocaleEnglishName(locale) || locale;
}

/**
 * Generate resource content using inference
 */
export async function generateResourceFromTopic(
  topic: string,
  entityTypes: string[],
  client: InferenceClient,
  userPrompt?: string,
  locale?: string,
  context?: YieldContext,
  temperature?: number,
  maxTokens?: number,
  logger?: Logger
): Promise<{ title: string; content: string }> {
  logger?.debug('Generating resource from topic', {
    topicPreview: topic.substring(0, 100),
    entityTypes,
    hasUserPrompt: !!userPrompt,
    locale,
    hasContext: !!context,
    temperature,
    maxTokens
  });

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
    return {
      title: topic,
      content: content
    };
  };

  logger?.debug('Sending prompt to inference', {
    promptLength: prompt.length,
    temperature: finalTemperature,
    maxTokens: finalMaxTokens
  });
  const response = await client.generateText(prompt, finalMaxTokens, finalTemperature);
  logger?.debug('Got response from inference', { responseLength: response.length });

  const result = parseResponse(response);
  logger?.debug('Parsed response', {
    hasTitle: !!result.title,
    titleLength: result.title?.length,
    hasContent: !!result.content,
    contentLength: result.content?.length
  });

  return result;
}
