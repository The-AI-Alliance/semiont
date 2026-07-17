import type { InferenceClient } from '@semiont/inference';
import { getLocaleEnglishName, isArray, isObject, isString, type Logger } from '@semiont/core';
import { boundedGenerateWithMetadata } from '../inference-call';

/**
 * Entity reference extracted from text — pre-reconciliation.
 *
 * The LLM emits `exact` (verbatim text span), `entityType`, and optional
 * `prefix` / `suffix` context for disambiguation. Offsets are not asked
 * for — `reconcileSelector` computes them by anchoring `exact` against
 * the source content in the calling processor.
 */
export interface ExtractedEntity {
  exact: string;
  entityType: string;
  prefix?: string;
  suffix?: string;
}

/**
 * Extract entity references from text using AI.
 *
 * Locale: entity references' bodies are entity-type identifiers (not
 * LLM-generated natural-language text), so only `sourceLanguage` (source-
 * resource locale) is meaningful here — it's used in the prompt so the LLM
 * analyzes non-English source correctly. There's no body-locale parameter.
 *
 * @param text - The text to analyze
 * @param entityTypes - Array of entity types to detect (optionally with examples)
 * @param client - Inference client for AI operations
 * @param includeDescriptiveReferences - Include anaphoric/cataphoric references (default: false)
 * @param logger - Logger for entity-extraction diagnostics (parse failures,
 *   anchor decisions, drops). Required so dropped/filtered entities never
 *   disappear silently.
 * @param sourceLanguage - BCP-47 tag for the source content's language
 * @returns Array of extracted entities with their character offsets
 */
export async function extractEntities(
  exact: string,
  entityTypes: string[] | { type: string; examples?: string[] }[],
  client: InferenceClient,
  includeDescriptiveReferences: boolean,
  logger: Logger,
  sourceLanguage?: string
): Promise<ExtractedEntity[]> {

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

  const sourceLangGuidance = sourceLanguage
    ? `\nSource text language: ${getLocaleEnglishName(sourceLanguage) || sourceLanguage}.\n`
    : '';

  // The LLM is asked for `exact`, `prefix`, and `suffix` — no character
  // offsets. Offsets get computed by `reconcileSelector` against the
  // source content. Asking the model for offsets wastes tokens and
  // encourages it to fabricate where it shouldn't.
  const prompt = `Identify entity references in the following text. Look for mentions of: ${entityTypesDescription}.
${descriptiveReferenceGuidance}${sourceLangGuidance}
Text to analyze:
"""
${exact}
"""

Respond with a JSON array of entities found. Each entity should have:
- exact: the exact text span from the input (quoted verbatim — character-for-character)
- entityType: one of the provided entity types
- prefix: up to 64 characters of text immediately before the entity (used to disambiguate when the same text appears more than once)
- suffix: up to 64 characters of text immediately after the entity (same purpose)

If no entities are found, respond with an empty array [].

Example output:
[{"exact":"Alice","entityType":"Person","prefix":"","suffix":" went to"},{"exact":"Paris","entityType":"Location","prefix":"went to ","suffix":" yesterday"}]`;

  logger.debug('Sending entity extraction request', { entityTypes: entityTypesDescription });
  const response = await boundedGenerateWithMetadata(
    client,
    prompt,
    4000, // Increased to handle many entities without truncation
    0.3,  // Lower temperature for more consistent extraction
    // Force grammar-constrained JSON output. Without this, Ollama models
    // periodically emit malformed JSON (truncated brackets, mid-token
    // breaks at higher token counts) which silently parse-fails into
    // [] downstream. The prompt's schema (which keys, what types) still
    // governs *what* the JSON contains; `format: 'json'` governs that
    // it's syntactically valid.
    { format: 'json' },
  );
  logger.debug('Got entity extraction response', { responseLength: response.text.length });

  // Truncation is data loss, not "no entities" — check it BEFORE parsing.
  // Post-Phase-1 a truncated response is a syntactically-valid but incomplete
  // array (the structured-output path serializes whatever was generated), so
  // JSON.parse would succeed and the loss would be invisible. Fail loudly.
  if (response.stopReason === 'max_tokens') {
    const errorMsg = 'Entity extraction response truncated (max_tokens) — increase max_tokens or reduce resource size; failing the job rather than dropping annotations.';
    logger.error(errorMsg, { responseLength: response.text.length });
    throw new Error(errorMsg);
  }

  // A parse failure used to be swallowed as `[]` — silent data loss
  // indistinguishable from a legitimately-empty extraction. Surface it as a
  // thrown error so the job fails (job:failed) and `withSpan` marks the span.
  let entities: unknown;
  try {
    entities = JSON.parse(response.text.trim());
  } catch (error) {
    logger.error('Failed to parse entity extraction response', {
      error: error instanceof Error ? error.message : String(error),
      response: response.text.slice(0, 500),
    });
    throw new Error('Failed to parse entity extraction response', {
      cause: error instanceof Error ? error : new Error(String(error)),
    });
  }

  if (!isArray(entities)) {
    logger.error('Failed to parse entity extraction response: expected a JSON array', {
      response: response.text.slice(0, 500),
    });
    throw new Error('Failed to parse entity extraction response: expected a JSON array');
  }

  logger.debug('Parsed entities from AI response', { count: entities.length });

  return entities
    .filter((e): e is Record<string, unknown> & { exact: string; entityType: string } => {
      const ok = isObject(e) && isString(e.exact) && isString(e.entityType);
      if (!ok) {
        logger.debug('Dropped malformed LLM entity', { entity: e });
      }
      return ok;
    })
    .map((entity): ExtractedEntity => ({
      exact: entity.exact,
      entityType: entity.entityType,
      ...(isString(entity.prefix) ? { prefix: entity.prefix } : {}),
      ...(isString(entity.suffix) ? { suffix: entity.suffix } : {}),
    }));
}
