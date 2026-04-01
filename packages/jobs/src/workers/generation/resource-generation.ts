/**
 * Resource Generation
 *
 * Generates markdown resources from topics using AI inference.
 */

import { getLocaleEnglishName } from '@semiont/api-client';
import type { GatheredContext, Logger } from '@semiont/core';
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
  context?: GatheredContext,
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

  // Use provided values or defaults.
  // 500 tokens is the canonical backend default for maxTokens; the UI also initialises
  // its field to 500 as a UX convenience, but the authoritative fallback lives here so
  // that direct API callers get a sensible limit even when they omit the parameter.
  const finalTemperature = temperature ?? 0.7;
  const finalMaxTokens = maxTokens ?? 500;

  // Determine language instruction
  const languageInstruction = locale && locale !== 'en'
    ? `\n\nIMPORTANT: Write the entire resource in ${getLanguageName(locale)}.`
    : '';

  // Build annotation context section if available
  let annotationSection = '';
  if (context) {
    const parts: string[] = [];
    parts.push(`- Annotation motivation: ${context.annotation.motivation}`);
    parts.push(`- Source resource: ${context.sourceResource.name}`);
    // Include body text for commenting/assessing annotations
    const { motivation, body } = context.annotation;
    if (motivation === 'commenting' || motivation === 'assessing') {
      const bodyItem = Array.isArray(body) ? body[0] : body;
      if (bodyItem && 'value' in bodyItem && bodyItem.value) {
        const label = motivation === 'commenting' ? 'Comment' : 'Assessment';
        parts.push(`- ${label}: ${bodyItem.value}`);
      }
    }
    annotationSection = `\n\nAnnotation context:\n${parts.join('\n')}`;
  }

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

  // Build graph context section if available
  let graphContextSection = '';
  if (context?.graphContext) {
    const gc = context.graphContext;
    const connections = gc.connections ?? [];
    const citedBy = gc.citedBy ?? [];
    const parts: string[] = [];

    if (connections.length > 0) {
      const connList = connections
        .map(c => `${c.resourceName}${c.entityTypes?.length ? ` (${c.entityTypes.join(', ')})` : ''}`)
        .join(', ');
      parts.push(`- Connected resources: ${connList}`);
    }

    if (gc.citedByCount && gc.citedByCount > 0) {
      const citedNames = citedBy.map(c => c.resourceName).join(', ');
      parts.push(`- This resource is cited by ${gc.citedByCount} other resource${gc.citedByCount > 1 ? 's' : ''}${citedNames ? `: ${citedNames}` : ''}`);
    }

    if (gc.siblingEntityTypes && gc.siblingEntityTypes.length > 0) {
      parts.push(`- Related entity types in this document: ${gc.siblingEntityTypes.join(', ')}`);
    }

    if (gc.inferredRelationshipSummary) {
      parts.push(`- Relationship summary: ${gc.inferredRelationshipSummary}`);
    }

    if (parts.length > 0) {
      graphContextSection = `\n\nKnowledge graph context:\n${parts.join('\n')}`;
    }
  }

  const structureGuidance = finalMaxTokens >= 1000
    ? 'organized into titled sections (## Section) with well-structured paragraphs'
    : 'organized into well-structured paragraphs';

  // Simple, direct prompt - just ask for markdown content
  const prompt = `Generate a concise, informative resource about "${topic}".
${entityTypes.length > 0 ? `Focus on these entity types: ${entityTypes.join(', ')}.` : ''}
${userPrompt ? `Additional context: ${userPrompt}` : ''}${annotationSection}${contextSection}${graphContextSection}${languageInstruction}

Requirements:
- Start with a clear heading (# Title)
- Aim for approximately ${finalMaxTokens} tokens of content, ${structureGuidance}
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
