import type { ResourceId } from '@semiont/sdk';
import type { ChatSession } from './session';

/** The SDK's own input type for `mark.annotation` — keeps us aligned with its schema. */
type CreateInput = Parameters<ChatSession['client']['mark']['annotation']>[0];
export type PendingSelector = NonNullable<CreateInput['target']['selector']>;
export type PendingMotivation = CreateInput['motivation'];
export type AnnotationBody = NonNullable<CreateInput['body']>;

/**
 * Create an annotation from a viewer selection (the annotate-mode flow). The embeddable
 * viewer captures the selection (text span / drawn shape) and emits `mark:requested` with
 * ready-made W3C selectors; the host creates. Same SDK plumbing as the Semiont Browser's
 * panels (`mark.annotation` with the emitted selector), minus its bus-mediated state unit —
 * chat mounts many viewers on ONE session, so routing/state live with each viewer instead.
 *
 * The trailing `browse.annotations(...).fresh()` does a one-shot fetch into the cache the
 * viewer's loader subscribes to, so the new annotation paints without waiting on the SSE
 * round-trip (same poke as the browse-mode selection-linking path).
 */
export async function createAnnotationFromSelection(
  session: ChatSession,
  resourceId: ResourceId,
  selector: PendingSelector,
  motivation: PendingMotivation,
  body?: AnnotationBody,
): Promise<void> {
  await session.client.mark.annotation({
    motivation,
    target: { source: resourceId, selector },
    ...(body !== undefined ? { body } : {}),
  });
  await session.client.browse.annotations(resourceId).fresh();
}
