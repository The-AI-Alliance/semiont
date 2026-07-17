/**
 * Resource Generation
 *
 * Generates markdown resources from topics using AI inference.
 */

import { getLocaleEnglishName, deriveViews } from '@semiont/core';
import type { GatheredContext, Logger, SupportedMediaType } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import { boundedGenerate } from '../inference-call';


function getLanguageName(locale: string): string {
  return getLocaleEnglishName(locale) || locale;
}

// Prompt-embedding caps — bound the context fed to the model (CONTEXT-IDENTIFIERS
// D4: named constants; promote to caller-tunable options only if a consumer
// actually hits the wall). A fact past these bounds never reaches the model.
const RESOURCE_CONTENT_CAP = 4000;
const SEMANTIC_MATCH_LIMIT = 3;
const SEMANTIC_MATCH_CHARS = 240;

/**
 * Model-visible identifier handle for an embedded excerpt — the ONE bracket
 * convention across all context sections (CONTEXT-IDENTIFIERS D1/D2): resource id
 * always, annotation id as a suffix when the excerpt is annotation-derived.
 */
function idLabel(resourceId: string, annotationId?: string): string {
  return `[${resourceId}${annotationId ? `/${annotationId}` : ''}]`;
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
  sourceLanguage?: string,
  outputMediaType: SupportedMediaType = 'text/markdown',
  task: string = 'resource',
  structure?: string,
  cite: boolean = false
): Promise<{ title: string; content: string }> {
  logger.debug('Generating resource from topic', {
    topicPreview: topic.substring(0, 100),
    entityTypes,
    hasUserPrompt: !!userPrompt,
    locale,
    sourceLanguage,
    hasContext: !!context,
    temperature,
    maxTokens,
    outputMediaType,
    task,
    structure
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
      parts.push(`- Source resource: ${focus.sourceResource.name} ${idLabel(mainResourceId)}`);
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
    } else {
      // Resource focus — ground in the focal resource's summary, suggested
      // references, and content (omit-empty). Content is capped per resource to
      // bound prompt size; the caller already chose breadth via gather.resource.
      const parts = [`- Resource: ${focus.resource.name} ${idLabel(mainResourceId)}`];
      if (focus.summary) parts.push(`- Summary: ${focus.summary}`);
      if (focus.suggestedReferences && focus.suggestedReferences.length > 0) {
        parts.push(`- Suggested references: ${focus.suggestedReferences.join(', ')}`);
      }
      resourceSection = `\n\nResource context:\n${parts.join('\n')}`;

      if (focus.content?.main) {
        resourceSection += `\n\nResource content:\n---\n${focus.content.main.slice(0, RESOURCE_CONTENT_CAP)}\n---`;
      }
      const related = Object.entries(focus.content?.related ?? {});
      if (related.length > 0) {
        const blocks = related
          .map(([id, text]) => `[${id}]\n${text.slice(0, RESOURCE_CONTENT_CAP)}`)
          .join('\n\n');
        resourceSection += `\n\nRelated resource content:\n---\n${blocks}\n---`;
      }
    }

    // Shared base: graph-derived neighborhood (connections / citedBy / siblings)
    // plus the LLM relationship summary, recomputed from the unified graph.
    if (mainResourceId) {
      const views = deriveViews(context.graph, mainResourceId, focalAnnotationId);
      const parts: string[] = [];

      if (views.connections.length > 0) {
        const connList = views.connections
          .map(c => `${c.resourceName}${c.entityTypes.length ? ` (${c.entityTypes.join(', ')})` : ''} ${idLabel(c.resourceId)}`)
          .join(', ');
        parts.push(`- Connected resources: ${connList}`);
      }

      if (views.citedByCount > 0) {
        const citedNames = views.citedBy.map(c => `${c.resourceName} ${idLabel(c.resourceId)}`).join(', ');
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
  // Capped and truncated to bound prompt cost (see the named caps above); the
  // gather step pre-filters to ≤10 matches above a 0.5 cosine threshold. Each
  // passage carries its source id so the model can attribute what it uses.
  // See .plans/SEMANTIC-CONTEXT-RAG.md + .plans/CONTEXT-IDENTIFIERS.md.
  let semanticContextSection = '';
  const similar = context?.semanticContext?.similar ?? [];
  if (similar.length > 0) {
    const lines = [...similar]
      .sort((a, b) => b.score - a.score)
      .slice(0, SEMANTIC_MATCH_LIMIT)
      .map(m => `- ${idLabel(m.resourceId, m.annotationId)} (${m.score.toFixed(2)}) ${m.text.slice(0, SEMANTIC_MATCH_CHARS)}`);
    semanticContextSection = `\n\nRelated passages from the knowledge base:\n${lines.join('\n')}`;
  }

  // ── Task framing (YIELD-STRUCTURE D1): canonical tasks map to tested framings;
  // an unknown task string is used VERBATIM as the framing instruction (loud
  // degrade — warn, never a silent fallback to 'resource').
  let leadLine: string;
  if (task === 'resource') {
    leadLine = `Generate a concise, informative resource about "${topic}".`;
  } else if (task === 'answer') {
    leadLine = `Answer the following question directly and concisely, grounded in the provided context: "${topic}"`;
  } else if (task === 'summary') {
    leadLine = `Write a concise summary of "${topic}".`;
  } else {
    logger.warn('Unknown task — using it verbatim as the framing instruction', { task });
    leadLine = `${task}\nTopic: "${topic}"`;
  }

  // ── Structure directive (YIELD-STRUCTURE D2/D4): emitted ONLY when the caller
  // sets one — unset means no directive at all (the task framing and the model
  // determine shape). Never derived from the token budget: maxTokens is length
  // only. The forced `# Title` heading exists only under canonical 'sections'.
  const isPlainText = outputMediaType === 'text/plain';
  let structureRequirement = '';
  let titleRequirement = '';
  if (structure === 'sections') {
    structureRequirement = isPlainText
      ? '\n- Organize the content into titled sections with well-structured paragraphs'
      : '\n- Organize the content into titled sections (## Section) with well-structured paragraphs';
    if (!isPlainText) {
      titleRequirement = '\n- Start with a clear heading (# Title)';
    }
  } else if (structure === 'prose') {
    structureRequirement = '\n- Write flowing, well-structured paragraphs with no section headings';
  } else if (structure === 'chat') {
    structureRequirement = '\n- Structure the content as a conversational chat transcript — a sequence of alternating, speaker-labeled turns (no section headings)';
  } else if (structure) {
    logger.warn('Unknown structure — passing it through as freeform organization guidance', { structure });
    structureRequirement = `\n- Organize the output as: ${structure}`;
  }

  // Citation instruction (INLINE-CITATIONS): ask the model to emit [[<id>]]
  // transport tokens next to each claim, citing only ids the context embedding
  // shows. The worker strips the tokens and reconciles them into linking
  // annotations — they never reach the stored content.
  const citeRequirement = cite
    ? '\n- Ground every claim in the provided context. Immediately after each claim, cite its source by emitting [[<id>]], where <id> is an id shown in square brackets in the context above (for a passage labeled [abc], emit [[abc]]). Cite only ids that appear in the context.'
    : '';

  const formatRequirements = isPlainText
    ? `- Write the response as plain text — no formatting markup (no #, *, backticks, headings, or links)
- Begin with the title on its own first line`
    : `- Use markdown formatting
- Write the response as markdown`;

  // The caller's prompt is an authoritative leading Instruction (YIELD-STRUCTURE D3),
  // not background "additional context" — task = what to produce, prompt = how.
  const prompt = `${leadLine}
${userPrompt ? `Instruction: ${userPrompt}` : ''}
${entityTypes.length > 0 ? `Focus on these entity types: ${entityTypes.join(', ')}.` : ''}${annotationSection}${contextSection}${resourceSection}${graphSection}${semanticContextSection}${sourceLanguageInstruction}${languageInstruction}

Requirements:
- Aim for approximately ${finalMaxTokens} tokens of content
- Be factual and informative${structureRequirement}${titleRequirement}${citeRequirement}
${formatRequirements}`;

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
  const response = await boundedGenerate(client, prompt, finalMaxTokens, finalTemperature);
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
