import { GenerationStallError } from '@semiont/sdk';
import { extractContext, textOffsets } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import { QUESTION_ENTITY_TYPE, type ChatSession, type ChatTurnResult } from './session';

/** The orchestration phase a running turn is awaiting. Finding references is no longer part
 *  of the turn — it's delegated on demand to the KB AI (src/lib/delegation.ts). */
export type TurnPhase = 'gathering' | 'yielding';

/** What a running turn reports to its driver: phase transitions, and the question's
 *  resource id AS SOON AS it exists (mid-turn, after its mention annotations are created)
 *  — so the UI can mount the annotated question bubble while the answer still generates. */
export type TurnEvent = { kind: 'phase'; phase: TurnPhase } | { kind: 'question'; questionId: ResourceId };

/**
 * Chat-sized deadline for the SDK's generation stall guard: the derived default floors at
 * 120s; chat's short-answer profile tightens to 90s. The guard is the SDK's — armed at
 * subscribe, re-armed per streamed event, cleared by the terminal — and on silence past
 * the deadline it cancels the job on the wire (`job:cancel-requested`, by its id) and
 * rejects with `GenerationStallError`. It guards a transport that died: a terminal frame
 * the worker sends cannot reach a session that stopped hearing, but silence here trips it.
 */
const GENERATION_STALL_MS = 90_000;

/** A document the user chose via an `@`-mention while composing — becomes a real,
 *  pre-resolved reference annotation on the question resource at send (UNIFY plan, D2
 *  path a). The `@` is only the compose-time trigger: the chip (and therefore the sent
 *  text) carries the BARE name, and the composer's serialize records the chip's exact
 *  span so anchoring is positional, never a text search. */
export interface PendingReference {
  /** Mention-kind discriminator. Only documents today; `'collaborator'` is reserved for
   *  delegation utterances ("@semiont, please…" — DELEGATION.md Phase 3). */
  kind: 'resource';
  name: string;
  resourceId: ResourceId;
  /** The chip's exact span in the serialized text (composer-derived, authoritative). */
  start: number;
  end: number;
}

export interface ChatTurnParams {
  question: string;
  /** `@`-mentions whose tokens survived to the sent text. */
  references?: PendingReference[];
}

/**
 * Create ONE **pre-resolved** W3C reference annotation on `resourceId`: a `linking` annotation
 * anchored on a span of the resource's own text (TextPosition + TextQuote selectors, context via
 * core's `extractContext`) whose body is the chosen referent (`SpecificResource`) — no stub, no
 * match/bind. Shared by the compose-time `@`-mention path and post-send selection-linking.
 */
export async function createResolvedReference(
  session: ChatSession,
  resourceId: ResourceId,
  text: string,
  /** In OFFSETS: code points from the start of `text`, the count every selector states.
   *  Not a string's own positions, which differ after a character outside the basic plane. */
  span: { start: number; end: number },
  targetResourceId: ResourceId,
): Promise<void> {
  const { start, end } = span;
  const offsets = textOffsets(text);
  const context = extractContext(text, start, end);
  await session.client.mark.annotation({
    motivation: 'linking',
    target: {
      source: resourceId,
      selector: [
        { type: 'TextPositionSelector', start, end },
        {
          type: 'TextQuoteSelector',
          exact: text.slice(offsets.indexAt(start), offsets.indexAt(end)),
          ...(context.prefix !== undefined ? { prefix: context.prefix } : {}),
          ...(context.suffix !== undefined ? { suffix: context.suffix } : {}),
        },
      ],
    },
    body: { type: 'SpecificResource', source: targetResourceId, purpose: 'linking' },
  });
}

/**
 * The mention batch: one resolved reference per composer chip, anchored on the chip's exact
 * span in the sent text. Offsets come from the composer's serialize — the DOM walk knows
 * precisely where each chip landed — so there is no token search (a bare name occurring
 * earlier as plain prose can never steal the anchor). A mention whose offsets don't match
 * the text is skipped: never mis-anchor.
 */
export async function createResolvedReferences(
  session: ChatSession,
  resourceId: ResourceId,
  text: string,
  references: PendingReference[],
): Promise<void> {
  // A chip's `start`/`end` are the composer's: positions in the string. A selector states
  // offsets, so they are converted here, once, where a mention becomes one.
  const offsets = textOffsets(text);
  for (const ref of references) {
    if (text.slice(ref.start, ref.end) !== ref.name) continue;
    const span = { start: offsets.offsetAt(ref.start), end: offsets.offsetAt(ref.end) };
    await createResolvedReference(session, resourceId, text, span, ref.resourceId);
  }
}

/**
 * One chat turn (Lane B) — framework-free, resource-focal. The question is its
 * own first-class resource; the answer is synthesized from the context gathered
 * around it. Returns a `run(onEvent)` the React layer drives (phase transitions + the
 * question id as soon as it exists).
 *
 * Pipeline: persist question → gather.resource → yield.delegate (Q&A-shaped:
 * task 'answer', prose, `cite` — the model grounds claims as it writes and the worker
 * mints them as linking annotations on the answer). The answer is ready as soon as this
 * resolves, citations included; FURTHER enrichment (finding references for chosen entity
 * types) stays a **separate, on-demand** step — delegated to the KB AI
 * (src/lib/delegation.ts) — complementing what the model cited inline.
 */
export function chatTurn(session: ChatSession, params: ChatTurnParams) {
  const { question, references } = params;

  return async (onEvent: (event: TurnEvent) => void): Promise<ChatTurnResult> => {
    const id = crypto.randomUUID();

    // 1. Persist the question as its own resource, tagged `Question` (the one type
    //    the app ensures, at sign-in). Reported as the gathering phase — prep for
    //    the KB-wide retrieval in step 2.
    onEvent({ kind: 'phase', phase: 'gathering' });
    const { resourceId: questionId } = await session.client.yield.resource({
      name: question,
      file: new File([question], `${id}.md`, { type: 'text/markdown' }),
      format: 'text/markdown',
      storageUri: `file://questions/${id}.md`,
      entityTypes: [QUESTION_ENTITY_TYPE],
    });

    // 1b. Each surviving `@`-mention becomes a real, resolved reference annotation on the
    //     question — created BEFORE gather so the referents are graph neighbors the
    //     retrieval can traverse (they're not Question-typed, so the exclusion won't drop them).
    if (references !== undefined && references.length > 0) {
      await createResolvedReferences(session, questionId, question, references);
    }

    // The question now exists WITH its mention annotations — hand the id to the UI so the
    // annotated question bubble mounts while the rest of the turn still runs.
    onEvent({ kind: 'question', questionId });

    // 2. GATHER context for the question resource — KB-wide retrieval, with prior
    //    questions excluded so they never ground the answer. Resolves to the
    //    GatheredContext directly (no annotation anchor, no optional unwrap).
    const context = await session.client.gather.resource(questionId, {
      excludeEntityTypes: [QUESTION_ENTITY_TYPE],
    });

    // 3. YIELD the answer resource: a `yield` job, delegated. The gathered context
    //    names what it is generated from (its focus is the question), so the job
    //    takes no resource id of its own. The streamed progress is coarse fixed
    //    checkpoints, so the turn awaits only the job's completion — which the
    //    worker reports AFTER it attaches every citation annotation (semiont
    //    docs/protocol/), so answers arrive with their citations minted.
    //
    //    Q&A-shaped generation (the INFERENCE-TEMPLATE resolution, tiers 1+3):
    //    `task` frames the output as an ANSWER to the title (not an article about
    //    it); `structure: 'prose'` suppresses the # Title / ## Section scaffolding;
    //    `cite` has the model wrap the words each source supports AS IT WRITES —
    //    `[[<id>: <claim>]]` against the context's embedded ids — which the worker
    //    takes out of the stored text and mints as W3C linking annotations ON the
    //    answer, over exactly the cited words (an id the context never showed is
    //    dropped). Those citations paint through the
    //    same overlay as every other reference; the on-demand delegation pass
    //    (find-references) remains complementary. `prompt` is the residual "how".
    onEvent({ kind: 'phase', phase: 'yielding' });
    const generation = session.client.yield.delegate(
      {
        context,
        title: question,
        storageUri: `file://answers/${id}.md`,
        task: 'answer',
        structure: 'prose',
        cite: true,
        prompt: 'Be direct and concise.',
      },
      GENERATION_STALL_MS,
    );

    // Await the completion directly (one subscription — awaiting IS the single run).
    // The SDK's stall guard rejects with a typed error and ships no copy, so chat
    // words the reconnect guidance itself.
    let completion;
    try {
      completion = await generation;
    } catch (err) {
      if (err instanceof GenerationStallError) {
        throw new Error(
          `The knowledge base went silent for ${err.deadlineMs / 1000}s while answering. ` +
            'The session may have expired — reconnect the knowledge base and ask again.',
        );
      }
      throw err;
    }

    // A `yield` job reports the resource it made, or a decline (the one with
    // `declined`: what it was to read could not be read). A completion with no
    // result is a question-only turn.
    const result = completion.result;
    if (result === undefined) return { questionId };
    if ('declined' in result) throw new Error(`The question could not be read (${result.reason}).`);
    // The truncated bit is surfaced only when set — a clean answer stays silent.
    return result.truncated
      ? { questionId, answerId: result.resourceId, answerTruncated: true }
      : { questionId, answerId: result.resourceId };
  };
}
