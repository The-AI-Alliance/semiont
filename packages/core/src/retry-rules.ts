/**
 * Which failures are worth another attempt — one catalog, several contexts.
 *
 * **Not `RetryPolicy`, which is next door and means something else.** That is a
 * timing budget: how long to keep trying. A `RetryRule` is which failures to try
 * again at all. `STARTUP_FETCH_RETRY: RetryPolicy` and `RETRY_RULES.boot` answer
 * different questions about the same attempt.
 *
 * ## Why one file, when the contexts genuinely differ
 *
 * They do differ, and collapsing them to one answer would break something: a
 * `500` mid-job is worth another attempt, where the same `500` in a boot pass
 * replays whatever broke it. The defect being fixed is not divergence — it is
 * that the divergence was **undeclared**. Four sites decided this question, two
 * with an argument and two with a bare list, and no reader of any file could see
 * that the others existed. Where a list and an argument disagreed, the list won
 * silently.
 *
 * So the rules sit together *because* they disagree. A reader comparing two lines
 * here sees a decision; a reader of one package could only ever see a default.
 *
 * This is the opposite call from `retry.ts`'s "judgment with its caller", and
 * deliberately: that rule governs timing budgets, where one number shared across
 * peers that answer differently caused a measured bug. Here the failure mode is
 * invisibility, and co-location is its cure. A context still owns its *choice* —
 * it picks a rule by name — it does not own a private copy of the reasoning.
 *
 * ## The census gate is reachability
 *
 * Rules are exported only through `RETRY_RULES`. A rule missing from that record
 * cannot be consumed, which is a stronger gate than a parallel list a new rule
 * could simply be left out of.
 */

/**
 * What is known about a failure at the moment someone asks.
 *
 * `method` exists because retryability depends on the REQUEST as well as the
 * failure: a `504` on a GET is safe to repeat, a `504` on a POST may already have
 * been processed upstream. Optional, because only the transport rule has an
 * answer for it — and unstated reads as unsafe rather than as permission.
 *
 * Deliberately not a `ReadonlySet<number>`: a status set cannot say *`401` on any
 * method, `5xx` on idempotent methods only*, which is exactly what the transport
 * needs to say.
 */
export interface RetryFacts {
  status?: number;
  /** HTTP method, any case. Absent means "not stated", which is treated as unsafe. */
  method?: string;
}

export interface RetryRule {
  readonly name: string;
  /** Why this context answers the way it does. Not decoration: the two bare
   *  lists this taxonomy replaces were bare because nobody had to write one. */
  readonly rationale: string;
  retryable(facts: RetryFacts): boolean;
}

/** Repeating these cannot cause a second effect upstream (RFC 9110 §9.2.2). */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  'GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE',
]);

const boot: RetryRule = {
  name: 'boot',
  rationale:
    'A boot pass or a bus request, where the peer is usually seconds from being ready. ' +
    '429/503/504 are the server saying "up, but not now" — retrying is compliance with its ' +
    'own instruction. 500 is excluded on the record: 503 and 504 are promises to recover, ' +
    'an unclassified server fault is not, and replaying it inside a boot pass re-runs ' +
    'whatever broke it. Auth and validation failures stay out for the same reason a 401 ' +
    'does — the gateway is up and rejected us.',
  retryable: ({ status }) => status === 429 || status === 503 || status === 504,
};

const job: RetryRule = {
  name: 'job',
  rationale:
    'A job retry budget, where the cost of NOT retrying is a discarded long-running ' +
    'attempt. 5xx is included where the boot rule excludes it, because the alternative is ' +
    'throwing away paid work over one unclassified fault. 408 joins as an explicit timeout. ' +
    'The price of a wrong "transient" is a re-pay, not a corrupted write — which is what ' +
    'makes the wider answer affordable here and not at boot.',
  retryable: ({ status }) =>
    status === 408 || status === 429 || (status !== undefined && status >= 500),
};

const transport: RetryRule = {
  name: 'transport',
  rationale:
    'An HTTP client with a token refresher. 401 is retried on ANY method: the request was ' +
    'rejected rather than processed, and a refreshed token makes it valid. Every other ' +
    'retryable status applies only to idempotent methods, because a POST that got a 502 may ' +
    'already have been processed — and one of them mints a fresh resource id, so a repeat ' +
    'writes a second resource the caller never learns about. Method-level is enough: no ' +
    'per-endpoint registry, because these methods were never retried before a widening that ' +
    'was meant to add 401 alone.',
  retryable: ({ status, method }) => {
    if (status === undefined) return false;
    if (status === 401) return true;
    const repeatable = method !== undefined && IDEMPOTENT_METHODS.has(method.toUpperCase());
    if (!repeatable) return false;
    return status === 408 || status === 413 || status === 429 || status === 500
      || status === 502 || status === 503 || status === 504;
  },
};

/**
 * Every rule, and the only way to reach one.
 *
 * Frozen and exhaustive on purpose — see the census-gate note above.
 */
export const RETRY_RULES = Object.freeze({ boot, job, transport });
