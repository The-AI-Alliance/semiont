import type { ElementSchema, InferenceClient } from '@semiont/inference';
import { chunkText, estimateTokens, getLocaleEnglishName, isObject, isString, type Logger } from '@semiont/core';
import { boundedGenerateStructured, boundedGenerateWithMetadata } from '../inference-call';
import { assertNotTruncated, callChunkSubdividing, deriveDetectionBudget, DETECTION_TEMPERATURE, YIELD_COLLAPSE_BAND, YieldCollapseError } from './detection-chunking';

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
 * JSON Schema for one extracted entity — the provider-enforced shape.
 *
 * Declared adjacent to `ExtractedEntity` deliberately: the schema is what
 * constrains the wire and the interface is what the code consumes, and
 * nothing verifies they agree — adjacency is the drift guard. The
 * per-element `isObject`/`isString` checks below stay as the structural
 * backstop (STRUCTURED-INFERENCE D5).
 *
 * `prefix`/`suffix` are deliberately NOT in `required`: with all four
 * required, models return `"prefix": ""` instead of omitting the key
 * (measured 2026-08-06), turning "sometimes absent" into "always present,
 * sometimes empty" — an anchoring-path change Phase 3 re-examines before
 * anyone relies on it.
 */
const ENTITY_ELEMENT_SCHEMA: ElementSchema = {
  type: 'object',
  properties: {
    exact: { type: 'string' },
    entityType: { type: 'string' },
    prefix: { type: 'string' },
    suffix: { type: 'string' },
  },
  required: ['exact', 'entityType'],
  additionalProperties: false,
};

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
 * @param onActivity - Invoked with (completedChunks, totalChunks) whenever
 *   the extraction is demonstrably alive: at each chunk boundary (the count
 *   advances) AND periodically while a single inference call is in flight
 *   (the count repeats — liveness, not progress). The caller MUST forward
 *   this to its progress channel: progress is the worker's liveness
 *   heartbeat for the stall watchdog, and the client's timeout is an
 *   INTER-EMISSION one, so a silent single-chunk run kills a healthy job
 *   (DETECTION-HEARTBEAT).
 * @returns Array of extracted entities with their character offsets
 */
/** Output cap for the count call: the answer is one number (≤7 digits), and a
 * tiny cap is itself the safety — a ~5-token output structurally cannot loop
 * or truncate the way the extraction's array can. */
const COUNT_MAX_TOKENS = 16;

/** The count answer, read as its leading integer. "Respond with only the
 * number" is the prompt's contract, but a model that pads it ("There are 50")
 * still yields its verdict; anything with no integer yields none. */
function parseCount(text: string): number | undefined {
  const m = text.trim().match(/\d+/);
  return m ? Number(m[0]) : undefined;
}

/**
 * The count-verifier (OLLAMA-DETECTION-TESTING P3c): guard a SUCCESSFUL
 * extraction against silent yield collapse (F7) — a schema-clean response
 * carrying a fraction of the mentions present, measured deterministic and
 * classification-invisible, so nothing else can catch it.
 *
 * A cheap count call ("respond with only the number") sets the expectation
 * FROM THE SAME TEXT — corpus-free, per the no-input-assumptions principle.
 * An extraction under 1/BAND of the count throws the collapse verdict, which
 * subdivision treats like truncation (descend by size) except at the floor,
 * where it fails the job loudly (user-ratified).
 *
 * The verifier's own failure — count call errors, or answers with no number —
 * disables it for the chunk (warn, pass through): a safety net's outage must
 * not take down a healthy extraction. Known limit, documented in the bug
 * report: the count saturates past ~8K chars, so margins are cleanest at
 * post-descent sizes; it still flagged every measured collapse at 16K/32K.
 */
async function assertYieldNotCollapsed(
  client: InferenceClient,
  piece: string,
  itemCount: number,
  entityTypesDescription: string,
  logger: Logger,
): Promise<void> {
  const prompt = `Count every mention of: ${entityTypesDescription} in the following text. Repeated mentions of the same entity count separately. Respond with only the number.

Text:
"""
${piece}
"""`;

  let counted: number | undefined;
  try {
    const response = await boundedGenerateWithMetadata(client, prompt, COUNT_MAX_TOKENS, DETECTION_TEMPERATURE, undefined, logger);
    counted = parseCount(response.text);
  } catch (err) {
    logger.warn('Count-verifier call failed — yield check skipped for this chunk', {
      pieceChars: piece.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (counted === undefined) {
    logger.warn('Count-verifier answer carried no number — yield check skipped for this chunk', { pieceChars: piece.length });
    return;
  }
  if (itemCount * YIELD_COLLAPSE_BAND < counted) {
    throw new YieldCollapseError(
      `Extraction found ${itemCount} entities where a count call reports ~${counted} mentions (band ×${YIELD_COLLAPSE_BAND}) on a ${piece.length}-char chunk — silent yield collapse (F7): deterministic, so a retry returns the identical under-report; subdividing instead.`,
    );
  }
}

export async function extractEntities(
  exact: string,
  entityTypes: string[] | { type: string; examples?: string[] }[],
  client: InferenceClient,
  includeDescriptiveReferences: boolean,
  logger: Logger,
  sourceLanguage?: string,
  onActivity?: (completedChunks: number, totalChunks: number) => void,
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
  const buildPrompt = (text: string): string => `Identify entity references in the following text. Look for mentions of: ${entityTypesDescription}.
${descriptiveReferenceGuidance}${sourceLangGuidance}
Text to analyze:
"""
${text}
"""

Respond with a JSON array of entities found. Each entity should have:
- exact: the exact text span from the input (quoted verbatim — character-for-character)
- entityType: one of the provided entity types
- prefix: up to 64 characters of text immediately before the entity (used to disambiguate when the same text appears more than once)
- suffix: up to 64 characters of text immediately after the entity (same purpose)

If no entities are found, respond with an empty array [].

Example output:
[{"exact":"Alice","entityType":"Person","prefix":"","suffix":" went to"},{"exact":"Paris","entityType":"Location","prefix":"went to ","suffix":" yesterday"}]`;

  // Budgets derive from the provider's actual limits + the measured scaffold
  // (the template around the content) — no literals. Input is chunked only
  // when the derived budget forces it; small documents make one call, as
  // before.
  const limits = await client.limits();
  // The verifier runs exactly where the risk was measured: rate-silent
  // providers — the same class P3b's assumed duration floor targets. A
  // provider that publishes its rate (Anthropic) showed no collapse and pays
  // for input twice if we count anyway, so it makes NO count call.
  const verifyYield = limits.outputTokensPerHour === undefined;
  const scaffoldTokens = estimateTokens(buildPrompt(''));
  // One call asks for every type in `entityTypes` — the processor's per-type
  // loop passes one, so this is 1 in production today.
  const { chunking, outputBudget } = deriveDetectionBudget(limits, scaffoldTokens, entityTypes.length);
  const chunks = chunkText(exact, chunking);

  logger.debug('Sending entity extraction request', {
    entityTypes: entityTypesDescription,
    chunks: chunks.length,
    chunkSizeTokens: chunking.chunkSize,
    outputBudget,
  });

  const collected: ExtractedEntity[] = [];
  for (let i = 0; i < chunks.length; i++) {
    // The structured surface returns parsed elements or THROWS — an
    // unreadable model response is a job failure, never a silent []. A
    // size-shaped failure (duration bound, truncation) subdivides in place
    // and retries smaller before it is allowed to fail the job.
    const items = await callChunkSubdividing<unknown>('reference', chunks[i]!, chunking, async (piece) => {
      const response = await boundedGenerateStructured<unknown>(
        client,
        buildPrompt(piece),
        outputBudget,
        DETECTION_TEMPERATURE,
        ENTITY_ELEMENT_SCHEMA,
        // Still alive, same position: a long single call would otherwise emit
        // nothing at all between start and finish.
        () => onActivity?.(i, chunks.length),
        logger,
      );
      logger.debug('Got entity extraction response', {
        chunk: i + 1,
        chunks: chunks.length,
        pieceChars: piece.length,
        items: response.items.length,
      });

      // Truncation is data loss, not "no entities" — check it BEFORE
      // consuming: a truncated structured response can still carry a valid
      // partial array, so the items themselves cannot signal the loss.
      assertNotTruncated(response, 'Entity extraction', i + 1, chunks.length, outputBudget);
      // And a CLEAN response can still be a silent under-report (F7) — the
      // count-verifier is the only signal for that, and a flag throws the
      // collapse verdict so subdivision changes the input.
      if (verifyYield) {
        await assertYieldNotCollapsed(client, piece, response.items.length, entityTypesDescription, logger);
      }
      // Usage rides back so the telemetry record carries what the call COST
      // beside what it yielded — the provider's own counts, not an estimate.
      return { items: response.items, ...(response.usage ? { usage: response.usage } : {}) };
    }, logger);

    for (const e of items) {
      // No dedupe here: overlap duplicates from adjacent chunks pass through
      // to the processor's span-keyed dedupeAnnotations — the single dedupe
      // point.
      if (isObject(e) && isString(e.exact) && isString(e.entityType)) {
        collected.push({
          exact: e.exact,
          entityType: e.entityType,
          ...(isString(e.prefix) ? { prefix: e.prefix } : {}),
          ...(isString(e.suffix) ? { suffix: e.suffix } : {}),
        });
      } else {
        logger.debug('Dropped malformed LLM entity', { entity: e });
      }
    }

    // Chunk boundary: the count advances (real progress).
    if (i < chunks.length - 1) {
      onActivity?.(i + 1, chunks.length);
    }
  }

  return collected;
}
