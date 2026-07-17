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
 * This is a timeout, not a cancellation: `InferenceOptions` has no
 * AbortSignal support, so on timeout the underlying HTTP request is
 * abandoned, not aborted — it settles (or dies at the socket level)
 * in the background, with its eventual rejection swallowed. Adding
 * `signal` to `@semiont/inference` would upgrade this to a true
 * abort; the timeout stays either way as the last line.
 */

import type { InferenceClient, InferenceOptions, InferenceResponse } from '@semiont/inference';

/**
 * Generous single-call bound. Slow local models on large prompts run
 * minutes, not tens of minutes; the stall watchdog (P3) sits above
 * this at 15 minutes, and the backend's dead-worker janitor above
 * that at 30. Fixed by design — no env knob.
 */
export const INFERENCE_TIMEOUT_MS = 10 * 60_000;

async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        `Inference call timed out after ${INFERENCE_TIMEOUT_MS / 60_000} minutes (${label}) — failing the job to keep the claim loop live`,
      ));
    }, INFERENCE_TIMEOUT_MS);
    timer.unref?.();
  });

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
  }
}

export function boundedGenerate(
  client: InferenceClient,
  prompt: string,
  maxTokens: number,
  temperature: number,
  options?: InferenceOptions,
): Promise<string> {
  return withTimeout(
    client.generateText(prompt, maxTokens, temperature, options),
    `${client.type}:${client.modelId}`,
  );
}

export function boundedGenerateWithMetadata(
  client: InferenceClient,
  prompt: string,
  maxTokens: number,
  temperature: number,
  options?: InferenceOptions,
): Promise<InferenceResponse> {
  return withTimeout(
    client.generateTextWithMetadata(prompt, maxTokens, temperature, options),
    `${client.type}:${client.modelId}`,
  );
}
