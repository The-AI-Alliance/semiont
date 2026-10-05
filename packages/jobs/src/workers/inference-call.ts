/**
 * Bounded inference calls — prevention: no model call may wait forever.
 *
 * The model call is the one await in the claim loop with no bound of its
 * own: bus operations have transport timeouts, the inference HTTP request
 * does not. Unbounded, one request that never settles wedges the worker
 * forever — the adapter ignores announcements while a job is held, so a
 * single stuck call silences the whole agent. Bounding the call converts
 * that silent hang into an ordinary job failure that flows through the
 * `job:fail` path (and the gateway's retry budget — a timeout is
 * transient-shaped, so retrying is correct) and frees the claim loop.
 *
 * This is a timeout AND a cancellation: on expiry the bound aborts the
 * underlying request through the `InferenceClient` signal, so the transport
 * — and, on the Anthropic path, the SDK's internal retry loop — is torn down
 * rather than left running as a billed zombie (one measured completing
 * 24–34 minutes after its job was gone). The timeout is the last line either
 * way; the abort accompanies it rather than replacing it — a bound that
 * cannot cancel is half a bound. The eventual settlement of the aborted
 * promise is swallowed so it cannot surface as an unhandled rejection.
 */

import type { ElementSchema, InferenceClient, InferenceResponse, StructuredResponse } from '@semiont/inference';
import type { Logger } from '@semiont/core';
import { withSpan } from '@semiont/observability';

/**
 * Generous single-call bound. Slow local models on large prompts run
 * minutes, not tens of minutes; the stall watchdog sits above this at
 * 15 minutes, and the gateway's dead-worker janitor above that at 30.
 * Fixed by design — no env knob.
 */
export const INFERENCE_TIMEOUT_MS = 10 * 60_000;

/**
 * The bound's own rejection, typed so failure classification never
 * string-matches our own error message. A timeout says nothing about the
 * request — it classifies transient.
 */
export class InferenceTimeoutError extends Error {
  override readonly name = 'InferenceTimeoutError';
}

/**
 * How often an in-flight call reports that it is still alive.
 *
 * Detection's other liveness signal — the chunk-boundary heartbeat — emits
 * `N − 1` events for `N` chunks, which is ZERO for a document that fits one
 * chunk. A 7-minute call then emits nothing at all, and the client's
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
 * percentage: nothing here knows how far a single model call has got.
 */
export type InferenceHeartbeat = () => void;

/**
 * One span per provider call. Without it a detection job is a SINGLE span
 * with no children on a fully instrumented stack, and telemetry cannot tell
 * extraction from inference. Attributes stay to what is known before the
 * answer arrives; token counts are recorded by `recordInferenceUsage` in the
 * client.
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

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  meta: { provider: string; model: string; label: string },
  onHeartbeat?: InferenceHeartbeat,
  logger?: Logger,
): Promise<T> {
  const controller = new AbortController();
  let timer!: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // True cancellation: tear the request down at the transport so it
      // cannot keep running (and billing) against a job that no longer
      // exists — and name the abort in the log, because an invisible
      // abandonment lets a zombie burn 24+ minutes unrecorded.
      logger?.warn('Aborting in-flight inference call at the timeout bound', {
        provider: meta.provider,
        model: meta.model,
        label: meta.label,
        boundMs: INFERENCE_TIMEOUT_MS,
      });
      controller.abort();
      reject(new InferenceTimeoutError(
        `Inference call timed out after ${INFERENCE_TIMEOUT_MS / 60_000} minutes (${meta.label}) — failing the job to keep the claim loop live`,
      ));
    }, INFERENCE_TIMEOUT_MS);
    timer.unref?.();
  });

  // One timer at one site covers every provider call — putting it in the
  // detection loops instead would couple liveness to detection's own
  // structure.
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

  const pending = work(controller.signal);
  try {
    return await Promise.race([pending, timedOut]);
  } catch (err) {
    // The aborted call settles promptly (AbortError from the transport), but
    // its rejection lands after the race is lost, so it is swallowed here to
    // keep it from surfacing as an unhandled one and killing the process.
    pending.catch(() => {});
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
  logger?: Logger,
): Promise<InferenceResponse> {
  return spanned(client, 'text', maxTokens, () => withTimeout(
    (signal) => client.generateTextWithMetadata(prompt, maxTokens, temperature, signal),
    { provider: client.type, model: client.modelId, label: `${client.type}:${client.modelId}` },
    onHeartbeat,
    logger,
  ));
}

export function boundedGenerateStructured<T>(
  client: InferenceClient,
  prompt: string,
  maxTokens: number,
  temperature: number,
  elementSchema: ElementSchema,
  onHeartbeat?: InferenceHeartbeat,
  logger?: Logger,
): Promise<StructuredResponse<T>> {
  return spanned(client, 'structured', maxTokens, () => withTimeout(
    (signal) => client.generateStructured<T>(prompt, maxTokens, temperature, elementSchema, signal),
    { provider: client.type, model: client.modelId, label: `${client.type}:${client.modelId}` },
    onHeartbeat,
    logger,
  ));
}
