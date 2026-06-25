/**
 * Resource Generation
 *
 * Generates markdown resources from topics using AI inference.
 */

import { getLocaleEnglishName, deriveViews } from '@semiont/core';
import type { GatheredContext, Logger } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';


function getLanguageName(locale: string): string {
  return getLocaleEnglishName(locale) || locale;
}

/**
 * Generate resource content using inference.
 *
 * Locale parameters: `locale` is the *body* locale — the language the
 * generated resource should be written in (sourced from the user's UI
 * locale). `sourceLanguage` is the *source* locale — the language of the
 * referenced resource whose context (selected passage, surrounding text)
 * is embedded into the prompt. They're independent: a German user can
 * generate German content from an English source resource. See
 * `types.ts` "Locale conventions" for the full discussion.
 */
export async function generateResourceFromTopic(
  topic: string,
  entityTypes: string[],
  client: InferenceClient,
  logger: Logger,
  userPrompt?: string,
  locale?: string,
  context?: GatheredContext,
  temperature?: number,
  maxTokens?: number,
  sourceLanguage?: string
): Promise<{ title: string; content: string }> {
  logger.debug('Generating resource from topic', {
    topicPreview: topic.substring(0, 100),
    entityTypes,
    hasUserPrompt: !!userPrompt,
    locale,
    sourceLanguage,
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

  // Determine language instructions. Body locale ("write the resource in X")
  // and source locale ("the embedded source text is in Y") are independent —
  // a German user can ask for a German write-up of an English source.
  const languageInstruction = locale && locale !== 'en'
    ? `\n\nIMPORTANT: Write the entire resource in ${getLanguageName(locale)}.`
    : '';
  const sourceLanguageInstruction = sourceLanguage
    ? `\n\nThe source resource and embedded context are in ${getLanguageName(sourceLanguage)}.`
    : '';

  // ── Context sections — switch on the unified GatheredContext focus ─────────
  // Annotation focus drives the annotation + selected-passage sections; resource
  // focus drives a minimal resource anchor (the full grounding — summary,
  // suggestedReferences, content — is YIELD-FROM-RESOURCE Gap B). The graph and
  // semantic sections are shared base, rendered for either focus.
  let annotationSection = '';
  let contextSection = '';
  let resourceSection = '';
  let graphSection = '';

  if (context) {
    const { focus } = context;
    // The focal resource's id — equal to the id `buildKnowledgeGraph` (P3) anchored
    // the graph's main node on, so `deriveViews` resolves edges. Read directly off
    // the descriptor (a plain string on the generated type); there is no event id to
    // thread here as the matcher had.
    const mainResourceId =
      focus.kind === 'annotation'
        ? focus.sourceResource['@id']
        : focus.resource['@id'];
    const focalAnnotationId = focus.kind === 'annotation' ? focus.annotation.id : undefined;

    if (focus.kind === 'annotation') {
      const parts: string[] = [];
      parts.push(`- Annotation motivation: ${focus.annotation.motivation}`);
      parts.push(`- Source resource: ${focus.sourceResource.name}`);
      // Include body text for commenting/assessing annotations
      const { motivation, body } = focus.annotation;
      if (motivation === 'commenting' || motivation === 'assessing') {
        const bodyItem = Array.isArray(body) ? body[0] : body;
        if (bodyItem && 'value' in bodyItem && bodyItem.value) {
          const label = motivation === 'commenting' ? 'Comment' : 'Assessment';
          parts.push(`- ${label}: ${bodyItem.value}`);
        }
      }
      annotationSection = `\n\nAnnotation context:\n${parts.join('\n')}`;

      if (focus.selected) {
        const { before, text, after } = focus.selected;
        contextSection = `\n\nSource document context:
---
${before ? `...${before}` : ''}
**[${text}]**
${after ? `${after}...` : ''}
---
`;
      }
    } else if (focus.resource.name) {
      // Minimal resource anchor — YIELD-FROM-RESOURCE Gap B fleshes out the
      // grounded resource section (summary / suggestedReferences / content).
      resourceSection = `\n\nFocal resource: ${focus.resource.name}`;
    }

    // Shared base: graph-derived neighborhood (connections / citedBy / siblings)
    // plus the LLM relationship summary, recomputed from the unified graph.
    if (mainResourceId) {
      const views = deriveViews(context.graph, mainResourceId, focalAnnotationId);
      const parts: string[] = [];

      if (views.connections.length > 0) {
        const connList = views.connections
          .map(c => `${c.resourceName}${c.entityTypes.length ? ` (${c.entityTypes.join(', ')})` : ''}`)
          .join(', ');
        parts.push(`- Connected resources: ${connList}`);
      }

      if (views.citedByCount > 0) {
        const citedNames = views.citedBy.map(c => c.resourceName).join(', ');
        parts.push(`- This resource is cited by ${views.citedByCount} other resource${views.citedByCount > 1 ? 's' : ''}${citedNames ? `: ${citedNames}` : ''}`);
      }

      if (views.siblingEntityTypes.length > 0) {
        parts.push(`- Related entity types in this document: ${views.siblingEntityTypes.join(', ')}`);
      }

      if (context.inferredRelationshipSummary) {
        parts.push(`- Relationship summary: ${context.inferredRelationshipSummary}`);
      }

      if (parts.length > 0) {
        graphSection = `\n\nKnowledge graph context:\n${parts.join('\n')}`;
      }
    }
  }

  // Build semantic context section if available — the vector matches the gather
  // flow already retrieved for the focal passage, used to ground generation (RAG).
  // Capped at top-3 by score and truncated per passage to bound prompt cost; the
  // gather step pre-filters to ≤10 matches above a 0.5 cosine threshold.
  // See .plans/SEMANTIC-CONTEXT-RAG.md.
  let semanticContextSection = '';
  const similar = context?.semanticContext?.similar ?? [];
  if (similar.length > 0) {
    const lines = [...similar]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(m => `- (${m.score.toFixed(2)}) ${m.text.slice(0, 240)}`);
    semanticContextSection = `\n\nRelated passages from the knowledge base:\n${lines.join('\n')}`;
  }

  const structureGuidance = finalMaxTokens >= 1000
    ? 'organized into titled sections (## Section) with well-structured paragraphs'
    : 'organized into well-structured paragraphs';

  // Simple, direct prompt - just ask for markdown content
  const prompt = `Generate a concise, informative resource about "${topic}".
${entityTypes.length > 0 ? `Focus on these entity types: ${entityTypes.join(', ')}.` : ''}
${userPrompt ? `Additional context: ${userPrompt}` : ''}${annotationSection}${contextSection}${resourceSection}${graphSection}${semanticContextSection}${sourceLanguageInstruction}${languageInstruction}

Requirements:
- Start with a clear heading (# Title)
- Aim for approximately ${finalMaxTokens} tokens of content, ${structureGuidance}
- Be factual and informative
- Use markdown formatting
- Write the response as markdown`;

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

  logger.debug('Sending prompt to inference', {
    promptLength: prompt.length,
    temperature: finalTemperature,
    maxTokens: finalMaxTokens
  });
  const response = await client.generateText(prompt, finalMaxTokens, finalTemperature);
  logger.debug('Got response from inference', { responseLength: response.length });

  const result = parseResponse(response);
  logger.debug('Parsed response', {
    hasTitle: !!result.title,
    titleLength: result.title?.length,
    hasContent: !!result.content,
    contentLength: result.content?.length
  });

  return result;
}
