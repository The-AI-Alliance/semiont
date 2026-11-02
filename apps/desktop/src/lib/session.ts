import {
  InMemorySessionStorage,
  SemiontSession,
  kbGatewayUrl,
  type KbTarget,
  type OpenedSession,
  type SessionEndReason,
} from '@semiont/sdk';
import type { KbDescription, ResourceId } from '@semiont/core';

/**
 * Entity type stamped on the question resources the GUI creates. Excluded from
 * `gather.resource`'s semantic recall (`excludeEntityTypes`) so prior questions
 * never ground a new answer.
 */
export const QUESTION_ENTITY_TYPE = 'Question';

/**
 * The single seam both lanes orchestrate over. A `ChatSession` IS a
 * `SemiontSession` — we use the wrapper (not a raw `SemiontClient`) because it
 * renews the bearer token; a raw client dies at the token's expiry. Namespaces
 * hang off `session.client.*`.
 */
export type ChatSession = SemiontSession;

/** One KB's live connection state, held per-KB by App (multiple KBs can be connected). */
export interface KbConnection {
  /** The session and the client it was built with, which end together (`dispose`):
   *  ending the session alone would leave the client's stream open. */
  opened?: OpenedSession;
  /** What the knowledge base says of itself: its name and the working tree's branch. */
  description?: KbDescription;
  connecting: boolean;
  error?: string;
}

/**
 * Connect to a knowledge base as the person signed in at its issuer.
 *
 * A stored session is resumed without a browser. When none is stored, or its issuer refused
 * to renew it, and `interactive` is set, the person signs in at the issuer in their own
 * browser. Without `interactive` (a launch reconnecting), nothing opens: no stored session
 * answers null, and a refused one throws, saying so. A session that cannot be read, or an
 * issuer that cannot be reached, throws with its cause either way: signing in again would
 * not fix it.
 *
 * The issuer's side is the desktop shell's (`AuthBridge`), which also keeps the tokens.
 * The session here holds an access token and asks the shell for the next one, so its own
 * storage is memory.
 *
 * `onEnded` is told when the session is over: its token could not be renewed, or the
 * knowledge base refused one its issuer had just issued.
 */
export async function connect(
  kb: KbTarget,
  options: { interactive: boolean; onEnded: (reason: SessionEndReason) => void },
): Promise<{ opened: OpenedSession; description: KbDescription } | null> {
  const bridge = typeof window !== 'undefined' ? window.authBridge : undefined;
  if (bridge === undefined) {
    throw new Error(
      'Signing in needs the desktop app. The knowledge base’s issuer refuses sign-in requests from this page.',
    );
  }
  if (kb.endpoint.kind !== 'http') {
    throw new Error(`Chat connects over HTTP; this knowledge base’s endpoint is "${kb.endpoint.kind}".`);
  }
  const { host, port, protocol } = kb.endpoint;

  const resumed = await bridge.resume(kb.id);
  let access: string;
  if (resumed.kind === 'resumed') access = resumed.access;
  else if (options.interactive) access = await bridge.signIn(kb.id, { host, port, protocol });
  else if (resumed.kind === 'none') return null;
  else throw new Error(`The issuer refused to renew the stored session (${resumed.reason}). Connect to sign in again.`);

  const opened = SemiontSession.fromHttp({
    kb,
    storage: new InMemorySessionStorage(),
    baseUrl: kbGatewayUrl(kb.endpoint),
    token: access,
    refresh: () => bridge.refresh(kb.id),
    onAuthFailed: options.onEnded,
  });
  try {
    const { session } = opened;
    await session.ready;

    // The KB owns its vocabulary, with one exception: the app marks its question
    // resources with the `Question` entity type (so prior questions are excluded from
    // recall). Ensure it exists in whatever KB we connect to. `frame.addEntityTypes`
    // is state-idempotent, and framed directly (no `browse.entityTypes()` dedup) so it
    // doesn't depend on the KB's entity-type read path.
    await session.client.frame.addEntityTypes([QUESTION_ENTITY_TYPE]);

    return { opened, description: await session.client.browse.kb() };
  } catch (err) {
    // A connection that fails after opening is ended here: nobody else holds it.
    opened.dispose();
    throw err;
  }
}

/** Sign out of a knowledge base: its session is revoked at the issuer and forgotten. */
export async function signOut(kb: KbTarget): Promise<void> {
  await window.authBridge?.signOut(kb.id);
}

/** Result of ingesting one document (Lane A): the created resource, embedded and
 *  usable for retrieval as soon as this resolves. Finding its references is a
 *  separate, on-demand delegation to the KB AI (src/lib/delegation.ts). */
export interface IngestResult {
  resourceId: ResourceId;
}

/** Result of one chat turn (Lane B): the persisted question resource and the
 *  generated answer resource. The answer is ready as soon as this resolves;
 *  finding its references is a separate, user-delegated pass (src/lib/delegation.ts). */
export interface ChatTurnResult {
  questionId: ResourceId;
  answerId?: ResourceId;
  /** Present (true) exactly when the generation stopped at the maxTokens ceiling
   *  (`YieldJobDone.truncated`) — the answer is real and cited, just cut off;
   *  the UI marks it quietly rather than erroring. */
  answerTruncated?: true;
}
