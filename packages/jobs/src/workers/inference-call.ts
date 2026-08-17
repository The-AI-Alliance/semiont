/**
 * Bounded inference calls — WORKER-LIVENESS.md P2 (G1: prevention).
 *
 * The claim loop's only unbounded await is the model call: bus
 * operations gained transport timeouts in 0.5.6, the inference HTTP
 * request did not. One request that never settles used to wedge the
 * worker forever — the adapter ignores announcements while
 * `isProcessing`, so a single stuck call silenced the whole agent.
 * Bounding the call converts that silent hang into an ordinary job
 * failure that flows through the existing `job:fail` path (and the
 * backend's retry budget — a timeout is transient-shaped, so retrying
 * is correct) and frees the claim loop.
 *
 * This is a timeout, not a cancellation: the `InferenceClient` surface has no
 * AbortSignal support, so on timeout the underlying HTTP request is
 * abandoned, not aborted — it settles (or dies at the socket level)
 * in the background, with its eventual rejection swallowed. Adding
 * `signal` to `@semiont/inference` would upgrade this to a true
 * abort; the timeout stays either way as the last line.
 */

import type { ElementSchema, InferenceClient, InferenceResponse, StructuredResponse } from '@semiont/inference';
import { withSpan } from '@semiont/observability';

/**
 * Generous single-call bound. Slow local models on large prompts run
 * minutes, not tens of minutes; the stall watchdog (P3) sits above
 * this at 15 minutes, and the backend's dead-worker janitor above
 * that at 30. Fixed by design — no env knob.
 */
export const INFERENCE_TIMEOUT_MS = 10 * 60_000;

/**
 * How often an in-flight call reports that it is still alive
 * (DETECTION-HEARTBEAT D2).
 *
 * Detection's other liveness signal — the chunk-boundary heartbeat — emits
 * `N − 1` events for `N` chunks, which is ZERO for the single-chunk case that
 * every realistic document falls into (the derived input budget is ~935 K
 * tokens). A 7-minute call then emits nothing at all, and the client's
 * *inter-emission* timeout (`mark-state-unit`, 180 s) kills a perfectly
 * healthy job.
 *
 * Sized against that consumer: 15 s gives ~12 beats of margin inside the
 * 180 s window. Fixed by design, like the bound above — no env knob.
 */
export const INFERENCE_HEARTBEAT_MS = 15_000;

/**
 * Called while a provider call is still in flight. Liveness only — the
 * caller repeats its current stage rather than inventing an advancing
 * percentage (D3): nothing here knows how far a single model call has got.
 */
export type InferenceHeartbeat = () => void;

/**
 * One span per provider call. Before this, a 411-second detection job was a
 * SINGLE span with no children on a fully instrumented stack — it was not
 * possible to tell extraction from inference from telemetry, which is what
 * made the sibling silent-empty bug expensive to find. Attributes stay to
 * what is known before the answer arrives; token counts are recorded by
 * `recordInferenceUsage` in the client.
 */
function spanned<T>(client: InferenceClient, kind: string, maxTokens: number, work: () => Promise<T>): Promise<T> {
  return withSpan(`inference:${kind}`, work, {
    attrs: {
      'inference.provider': client.type,
      'inference.model': client.modelId,
      'inference.max_tokens': maxTokens,
    },
  });
}

async function withTimeout<T>(work: Promise<T>, label: string, onHeartbeat?: InferenceHeartbeat): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        `Inference call timed out after ${INFERENCE_TIMEOUT_MS / 60_000} minutes (${label}) — failing the job to keep the claim loop live`,
      ));
    }, INFERENCE_TIMEOUT_MS);
    timer.unref?.();
  });

  // One timer at one site covers every provider call, present and future —
  // putting it in the detection loops instead would re-couple liveness to
  // detection's own structure, which is the coupling this exists to undo.
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (onHeartbeat) {
    heartbeat = setInterval(() => {
      try {
        onHeartbeat();
      } catch {
        // A failing progress emit must never take down the inference call
        // it is merely reporting on.
      }
    }, INFERENCE_HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  try {
    return await Promise.race([work, timedOut]);
  } catch (err) {
    // If the timeout won, the abandoned call may still settle later —
    // swallow its eventual rejection so it can't surface as an
    // unhandled one and kill the process.
    work.catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
    // Cleared with the timeout, in the same finally: a leaked interval would
    // beat forever on a completed job.
    if (heartbeat) clearInterval(heartbeat);
  }
}

export function boundedGenerateWithMetadata(
  client: InferenceClient,
  prompt: string,
  maxTokens: number,
  temperature: number,
  onHeartbeat?: InferenceHeartbeat,
): Promise<InferenceResponse> {
  return spanned(client, 'text', maxTokens, () => withTimeout(
    client.generateTextWithMetadata(prompt, maxTokens, temperature),
    `${client.type}:${client.modelId}`,
    onHeartbeat,
  ));
}

export function boundedGenerateStructured<T>(
  client: InferenceClient,
  prompt: string,
  maxTokens: number,
  temperature: number,
  elementSchema: ElementSchema,
  onHeartbeat?: InferenceHeartbeat,
): Promise<StructuredResponse<T>> {
  return spanned(client, 'structured', maxTokens, () => withTimeout(
    client.generateStructured<T>(prompt, maxTokens, temperature, elementSchema),
    `${client.type}:${client.modelId}`,
    onHeartbeat,
  ));
}
