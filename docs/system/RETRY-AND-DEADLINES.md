# Retry and Deadlines

Every peer in a knowledge base reaches another over the network at boot, and every one of
those connects can find its dependency not yet listening. Two mechanisms answer that, and the
rule for choosing between them is which end knows what:

- **A deadline** bounds waiting. `withDeadline(what, ms, work, hint)` races the work and hands
  it the deadline as an `AbortSignal`. On expiry it rejects; at boot that reaches a main's
  catch-all, which exits so the container restart policy can try again.
- **A retry** repeats a request that failed for a reason worth repeating. `retryWithBackoff`
  takes the operation, a predicate that says which failures qualify, a policy that says how
  long, and optionally a caller's signal.

Both live in `@semiont/core`'s `retry.ts` because they are one contract: the deadline produces
the signal, the retry consumes it. A retry that outlives its caller's deadline stops when that
deadline fires, rather than being abandoned mid-flight.

## The policies

A policy answers *how long until this specific peer is ready*. It is never shared between
peers that answer differently.

| policy | who waits | for what | budget |
|---|---|---|---|
| `STARTUP_FETCH_RETRY` | every peer | the **gateway** to accept authentication | 8 × 1s→8s ≈ 39s |
| `EMIT_RETRY` | every peer | the **gateway** to accept one `/bus/emit` | 4 × 1s→4s ≈ 7s |
| `RESOURCE_LISTING_RETRY` | weaver, smelter | the **archivist** to subscribe | 17 × 1s→30s ≈ 361s |
| `EMBEDDING_PROVIDER_RETRY` | archivist, librarian, smelter | the **embedding provider** to serve a model | 12 × 1s→15s ≈ 120s |

Budgets above are the delays alone. Each attempt is separately bounded — by
`EMBED_TIMEOUT_MS` (15s) for the provider, `EMIT_TIMEOUT_MS` (30s) for an emit, `busRequest`'s
30s for a bus request — so a wall-clock ceiling is delays plus attempts × that bound, and the
embedding provider's worst case is ~300s. Without a per-attempt bound an attempt count means
nothing: a `fetch` with no signal can sit in TCP retransmit for minutes.

Backoff is equal-jittered — each wait lands in `[cap/2, cap)` — so these are ceilings and the
expected wait is about three quarters of them. Jitter is not optional: these
are containers that boot together and retry against one gateway, and an identical schedule
re-converges N peers on the same instant.

**The budgets chain, and one of them is gated.** A projector waits on the archivist, whose own
boot contains two retries. `RESOURCE_LISTING_RETRY` therefore exceeds
`STARTUP_FETCH_RETRY + EMBEDDING_PROVIDER_RETRY` (339s), and `browse-resources.test.ts` asserts
it — lengthening what the archivist waits for fails that test rather than silently producing a
weaver that gave up on an archivist still starting.

## Which failures qualify

A predicate narrows an error type, and a retry site passes exactly one. Each site knows which
failure it is waiting out; there is no general "is this retryable?", because a bad API key and
a bus refusal both answer no for different reasons.

| predicate | true for | lives in |
|---|---|---|
| `isTransientFetchError` | `fetch` never connected | core |
| `isRetryableRequestError` | HTTP 429 / 503 / 504, or a `TimeoutError` | core |
| `isPeerUnavailable` | `bus.peer-unavailable` — the channel has no subscriber | core |
| `notReady` | the model is not pulled, **or** the provider is not listening | `@semiont/vectors` |

`notReady` is the one composition, and it is deliberate: at boot both failures are the same
wait with the same consequence — a flapping archivist strands the worker either way.

The exclusions carry as much weight as the inclusions. `isTransientFetchError` refuses every
HTTP-level failure, because a 401 means the gateway is up and rejected us. `isPeerUnavailable`
refuses `bus.unsubscribed`, which sounds identical and means the opposite end: *this* transport
is not subscribed to the reply channel, a local misconfiguration no waiting fixes.

## Where a retry belongs

A request travels four layers, and only two of them retry.

| layer | retries | why |
|---|---|---|
| `/bus/emit` POST | **yes** | transport refusals: the gateway is up and asking us to wait |
| `busRequest` | **no** | cannot know whether the operation is idempotent |
| the caller of `busRequest` | **yes** | knows what it asked for |
| the boot pass | **no** | a pass retry re-sends every request that already succeeded |

`busRequest`'s operations include both `browse:resource-requested` and
`yield:clone-resource-requested`. A read is idempotent; a create is not, and retrying one whose
reply timed out double-writes. Only the caller can tell those apart, which is why
`browseAllResources` wraps each page request and no write path retries at all.

The boot pass sits above everything and does one thing: record the phase, log, and **not**
exit. A repair pass that fails leaves a store behind; it does not leave the projector dead.

## What deliberately does not retry

**Graph and vector store connects** take a deadline instead — `withDeadline(what, 60s, …)` in
all four mains. These are one-shot connects with no transient class worth naming, and an
unbounded await leaves a container hung where `restart: on-failure` can only rescue a process
that exits.

**The SSE reconnect** is the one unbounded loop, with its own ladder capped at 60s. A dropped
subscription must always come back; every other site is a request with a caller waiting.

## Constants live with their callers

`retry.ts` holds the mechanism. Policies, deadlines and provider-specific predicates live in
the package that owns the question, and that placement is load-bearing: an embedding path that
borrowed `STARTUP_FETCH_RETRY` — sized for *until the gateway starts listening* — expired
waiting for a model download and killed three services on every first boot. `STARTUP_FETCH_RETRY`
is the one policy in core, because five boot paths genuinely share the question it answers.

## See also

- [CONTAINER-TOPOLOGY.md](CONTAINER-TOPOLOGY.md) — which peer runs where, and what depends on what.
- [KNOWLEDGE-SYSTEM.md](KNOWLEDGE-SYSTEM.md) — the actors behind these channels.
