import type { ElementSchema, InferenceClient } from '@semiont/inference';
import { estimateTokens, getLocaleEnglishName, isObject, isString, textOffsets, type Logger, type TextOffsets, type UnitCursor } from '@semiont/core';
import { boundedGenerateStructured, boundedGenerateWithMetadata } from '../inference-call';
import { assertNotTruncated, callChunkSubdividing, deriveDetectionBudget, runAdaptiveChunks, type ChunkCursor, DETECTION_TEMPERATURE, YIELD_COLLAPSE_BAND, YieldCollapseError, type UnderReportedPiece } from './detection-chunking';

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
 * backstop — the last line on the Ollama path.
 *
 * `prefix`/`suffix` are deliberately NOT in `required`: with all four
 * required, models return `"prefix": ""` instead of omitting the key,
 * turning "sometimes absent" into "always present, sometimes empty" — an
 * anchoring-path change avoided at the source here; `reconcileSelector` also
 * treats an empty hint as an absent one.
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
 * The count-verifier: guard a SUCCESSFUL extraction against silent yield
 * collapse — a schema-clean response carrying a fraction of the mentions
 * present, measured deterministic and classification-invisible, so nothing
 * else can catch it.
 *
 * A cheap count call ("respond with only the number") sets the expectation
 * FROM THE SAME TEXT — corpus-free, per the no-input-assumptions principle.
 * An extraction under 1/BAND of the count throws the collapse verdict, which
 * subdivision treats like truncation (descend by size) except at the floor,
 * where the flagged piece's salvage is accepted loudly rather than failing
 * the unit.
 *
 * The verifier's own failure — count call errors, or answers with no number —
 * disables it for the chunk (warn, pass through): a safety net's outage must
 * not take down a healthy extraction. Known limit: the count saturates past
 * ~8K chars, so margins are cleanest at post-descent sizes; it nonetheless
 * flags every measured collapse at 16K/32K.
 */
async function assertYieldNotCollapsed(
  client: InferenceClient,
  piece: string,
  items: readonly unknown[],
  entityTypesDescription: string,
  logger: Logger,
): Promise<number | undefined> {
  const prompt = `Count every mention of: ${entityTypesDescription} in the following text. Repeated mentions of the same entity count separately. Respond with only the number.

Text:
"""
${piece}
"""`;

  const pieceChars = textOffsets(piece).length;
  let counted: number | undefined;
  try {
    const response = await boundedGenerateWithMetadata(client, prompt, COUNT_MAX_TOKENS, DETECTION_TEMPERATURE, undefined, logger);
    counted = parseCount(response.text);
  } catch (err) {
    logger.warn('Count-verifier call failed — yield check skipped for this chunk', {
      pieceChars,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  if (counted === undefined) {
    logger.warn('Count-verifier answer carried no number — yield check skipped for this chunk', { pieceChars });
    return undefined;
  }
  if (items.length * YIELD_COLLAPSE_BAND < counted) {
    // The salvage rides the error: descent discards it (a smaller re-run does
    // better), the floor accepts it (better than nothing, and every span is
    // write-time-verified).
    throw new YieldCollapseError(
      `Extraction found ${items.length} entities where a count call reports ~${counted} mentions (band ×${YIELD_COLLAPSE_BAND}) on a ${pieceChars}-char chunk — silent yield collapse: deterministic — a same-size retry returns the identical under-report.`,
      [...items],
      { found: items.length, counted, pieceChars },
    );
  }
  return counted;
}

/**
 * Extract entity references from text using AI.
 *
 * Locale: entity references' bodies are entity-type identifiers (not
 * LLM-generated natural-language text), so only `sourceLanguage` (source-
 * resource locale) is meaningful here — it's used in the prompt so the LLM
 * analyzes non-English source correctly. There's no body-locale parameter.
 *
 * @param exact - The text to analyze
 * @param offsets - The text's own conversions (`textOffsets(exact)`), made
 *   once where the text is first held
 * @param entityTypes - Array of entity types to detect (optionally with examples)
 * @param client - Inference client for AI operations
 * @param includeDescriptiveReferences - Include anaphoric/cataphoric references
 * @param logger - Logger for entity-extraction diagnostics (parse failures,
 *   anchor decisions, drops). Required so dropped/filtered entities never
 *   disappear silently.
 * @param sourceLanguage - BCP-47 tag for the source content's language
 * @param onActivity - Invoked with (consumedChars, totalChars) whenever the
 *   extraction is demonstrably alive: at each chunk boundary (the cursor
 *   advances) AND periodically while a single inference call is in flight
 *   (the position repeats — liveness, not progress). Offsets, in code
 *   points, not chunk ordinals: chunk sizing is decided as the run goes, so there is no chunk
 *   total to divide by — and the cursor is the more honest numerator anyway,
 *   since boundary-seeking makes chunks unequal. The caller MUST forward
 *   this to its progress channel: progress is the worker's liveness
 *   heartbeat for the stall watchdog, and the client's timeout is an
 *   INTER-EMISSION one, so a silent single-chunk run kills a healthy job.
 * @returns Array of extracted entities
 */
export async function extractEntities(
  exact: string,
  offsets: TextOffsets,
  entityTypes: string[] | { type: string; examples?: string[] }[],
  client: InferenceClient,
  includeDescriptiveReferences: boolean,
  logger: Logger,
  sourceLanguage?: string,
  onActivity?: (consumedChars: number, totalChars: number) => void,
  /** A floor-accepted piece's evidence, as it is accepted. */
  onUnderReport?: (verdict: UnderReportedPiece) => void,
  /** Each accepted piece's count-verifier expectation — the denominator. */
  onCounted?: (counted: number) => void,
  /** Where an earlier attempt left this unit. Absent on a first attempt, and
   * then the run opens at the top. Deliberately BEFORE the callback below,
   * which stays last. */
  resume?: UnitCursor,
  /**
   * This chunk's entities, awaited before the loop continues: the caller
   * commits them, and the loop must not run ahead of durability. Unlike
   * `onActivity` (a liveness heartbeat, which may repeat), this fires exactly
   * once per chunk, including the last. Kept LAST on every detection seam —
   * test harnesses read it as the final positional argument, so a parameter
   * appended after it silently starves them of results.
   *
   * `cursor` is where the run stands ONCE THIS CHUNK IS COMMITTED — the pair
   * a resume checkpoint records, next offset and chunk size. It is handed over
   * with the results rather than reported separately so the two cannot drift:
   * a caller that records the position without durably committing the
   * annotations would checkpoint ahead of the log.
   */
  onChunkResults?: (items: ExtractedEntity[], cursor: ChunkCursor) => Promise<void>,
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
  // when the derived budget forces it; small documents make one call.
  const limits = await client.limits();
  // The provider DECLARES whether its extractions get count-verified
  // (universal for real providers — unverified completeness is not a
  // savings). Jobs does no provider-specific switching:
  // whatever varies by provider is a capability on the InferenceClient
  // contract, read here like `maxConcurrency`.
  const verifyYield = client.verifyDetectionYield;
  const scaffoldTokens = estimateTokens(buildPrompt(''));
  // One call asks for every type in `entityTypes` — the processor's per-type
  // loop passes one, so this is 1 in production.
  const budget = deriveDetectionBudget(limits, scaffoldTokens, entityTypes.length);
  const { chunking, outputBudget } = budget;

  logger.debug('Sending entity extraction request', {
    entityTypes: entityTypesDescription,
    chars: offsets.length,
    // The size the run OPENS at, and how far measured yield may move it. The
    // chunk COUNT is deliberately absent: with sizing decided as the run goes,
    // there is no honest total until the cursor reaches the end.
    openingChunkSizeTokens: chunking.chunkSize,
    ceilingChunkSizeTokens: budget.bounds.ceiling,
    outputBudget,
  });

  const collected: ExtractedEntity[] = [];
  await runAdaptiveChunks(exact, offsets, budget, async ({ piece: chunk, size, at, next, totalChars }) => {
    // The structured surface returns parsed elements or THROWS — an
    // unreadable model response is a job failure, never a silent []. A
    // size-shaped failure (duration bound, truncation) subdivides in place
    // and retries smaller before it is allowed to fail the job.
    const { items, outcome } = await callChunkSubdividing<unknown>(
      'reference', chunk, { chunkSize: size, overlap: chunking.overlap },
      async (piece) => {
        const response = await boundedGenerateStructured<unknown>(
          client,
          buildPrompt(piece),
          outputBudget,
          DETECTION_TEMPERATURE,
          ENTITY_ELEMENT_SCHEMA,
          // Still alive, same position: a long single call would otherwise emit
          // nothing at all between start and finish.
          () => onActivity?.(at, totalChars),
          logger,
        );
        logger.debug('Got entity extraction response', {
          at,
          totalChars,
          chunkSizeTokens: size,
          pieceChars: textOffsets(piece).length,
          items: response.items.length,
        });

        // Truncation is data loss, not "no entities" — check it BEFORE
        // consuming: a truncated structured response can still carry a valid
        // partial array, so the items themselves cannot signal the loss.
        assertNotTruncated(response, 'Entity extraction', at, totalChars, outputBudget);
        // And a CLEAN response can still be a silent under-report — the
        // count-verifier is the only signal for that, and a flag throws the
        // collapse verdict so subdivision changes the input.
        const counted = verifyYield
          ? await assertYieldNotCollapsed(client, piece, response.items, entityTypesDescription, logger)
          : undefined;
        // Usage rides back so the telemetry record carries what the call COST
        // beside what it yielded — the provider's own counts, not an estimate.
        return {
          items: response.items,
          ...(response.usage ? { usage: response.usage } : {}),
          ...(counted !== undefined ? { counted } : {}),
        };
      },
      logger, onUnderReport, onCounted,
    );

    const fromChunk: ExtractedEntity[] = [];
    for (const e of items) {
      // No dedupe here: overlap duplicates from adjacent chunks pass through
      // to the caller's decider — the single dedupe point.
      if (isObject(e) && isString(e.exact) && isString(e.entityType)) {
        fromChunk.push({
          exact: e.exact,
          entityType: e.entityType,
          ...(isString(e.prefix) ? { prefix: e.prefix } : {}),
          ...(isString(e.suffix) ? { suffix: e.suffix } : {}),
        });
      } else {
        logger.debug('Dropped malformed LLM entity', { entity: e });
      }
    }
    collected.push(...fromChunk);
    await onChunkResults?.(fromChunk, { next, size });

    // Chunk boundary: the cursor advances (real progress). Only when text
    // remains — the final cut has no boundary after it, and the caller reports
    // the unit's completion itself.
    if (next < totalChars) onActivity?.(next, totalChars);
    return outcome;
  }, resume);

  return collected;
}
