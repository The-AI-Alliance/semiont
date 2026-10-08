# Generated from specs/src/client/timing.json; do not edit.
# Regenerate: node scripts/spec/generate-client-timing-python.mjs

"""The timing a Semiont client keeps: its deadlines, its retry budgets, the
cadence of its stream, and what it keeps count of.

Each constant is an entry of the table every SDK generates from, under the
entry's own name: `emitRetry` is `EMIT_RETRY`. `TIMING_NAMES` lists the names
as the table states them, which is how a caller overrides one.
"""

from typing import Final

from semiont.retry import RetryPolicy

__all__ = [
    "BUS_REQUEST_TIMEOUT_MS",
    "DEGRADED_THRESHOLD_MS",
    "DELEGATE_SILENCE_MS",
    "EMIT_RETRY",
    "EMIT_TIMEOUT_MS",
    "GENERATED_TEXT_ASKS_COUNT",
    "GENERATION_STALL_ASSUMED_TOKENS_COUNT",
    "GENERATION_STALL_FLOOR_MS",
    "GENERATION_STALL_PER_TOKEN_MS",
    "HELD_JOB_STALL_CHECK_MS",
    "HELD_JOB_STALL_MS",
    "HOVER_DELAY_MS",
    "HTTP_REQUEST_TIMEOUT_MS",
    "INVALIDATION_WINDOW_MS",
    "JOB_CLAIM_TIMEOUT_MS",
    "JOB_SILENCE_MS",
    "JOB_STATUS_POLL_MS",
    "LAZY_REMOVE_MS",
    "LINGER_MS",
    "MAX_RECONNECT_MS",
    "MIN_REFRESH_DELAY_MS",
    "RECONNECT_DEBOUNCE_MS",
    "RECONNECT_MS",
    "REFRESH_BEFORE_EXP_MS",
    "REFRESH_RETRY",
    "SEARCH_DEBOUNCE_MS",
    "SEEN_EVENT_IDS_COUNT",
    "TIMING_NAMES",
]

# How long a bus request waits for its reply. The gateway keeps a reply for redelivery at least
# twice this long (`replyRetentionSeconds` on POST /bus/subscribe), so a reply published during
# an outage is still there when the requester reconnects inside its own deadline.
BUS_REQUEST_TIMEOUT_MS: Final = 30000

# The deadline on one POST /bus/emit. The gateway accepts an emit promptly; one still unanswered
# here means the gateway is unresponsive, and the emit is rejected rather than awaited forever.
# Without it a worker's emit to a wedged gateway hangs its loop.
EMIT_TIMEOUT_MS: Final = 30000

# The retry budget of ONE emit. Per request, never per boot pass: re-running a whole catch-up
# pass to recover from one refusal re-sends hundreds of emits that already succeeded. Small on
# purpose: an emit a caller awaits must fail while the caller still cares, and the patience for
# a gateway that is down belongs to the pass above it.
EMIT_RETRY: Final = RetryPolicy(attempts=4, initial_delay_ms=1000, max_delay_ms=4000)

# The deadline on one HTTP request that is neither the stream nor an emit: one of the gateway's
# own operations (who a token is, a media token, an agent's token, the resource metadata,
# health, status), the wait for a resource's bytes to begin arriving, a request to the issuer
# (its discovery, a grant, a revocation), and a read of a launcher's discovery document.
# Unanswered here, the request fails as one that got no answer. Without it, a gateway or an
# issuer that accepts a connection and never answers holds a session's start, and every renewal
# after it, for as long as the process lives. An upload has no deadline: how long it takes is
# how large the resource is.
HTTP_REQUEST_TIMEOUT_MS: Final = 30000

# The first wait before a failed stream is opened again. Each further failure doubles it, up to
# `maxReconnectMs`, and a successful open resets it. Also the cadence at which a transport with
# no usable credential checks for one, which costs no request.
RECONNECT_MS: Final = 5000

# The ceiling of the reconnect backoff: a long outage settles at about one attempt a minute
# instead of growing without bound.
MAX_RECONNECT_MS: Final = 60000

# How long a stream may be reconnecting before its state becomes degraded.
DEGRADED_THRESHOLD_MS: Final = 3000

# How long a superseded connection keeps draining after a make-before-break handoff. Closing it
# the instant its replacement opens discards replies already written to the old socket and not
# yet read. The overlap doubles nothing: a frame both connections carry has one id, and is
# delivered once (`seenEventIdsCount`).
LINGER_MS: Final = 1000

# How many of the event ids it delivered last a client remembers. A frame whose id is among them
# is one it has delivered already, and is dropped: that is what makes a frame carried by both
# streams of a handoff, or replayed to the new one, arrive once. A client that remembers fewer
# delivers twice whenever more than that many events pass between the two copies.
SEEN_EVENT_IDS_COUNT: Final = 512

# How long additions to the subscription are gathered before the stream is reopened with them.
# Short, because a new scope needs to be live now.
RECONNECT_DEBOUNCE_MS: Final = 100

# How long a removal from the subscription waits before the stream is reopened without it.
# Removal only narrows delivery, and reopening on every scope a viewer brushes past would churn
# the connection.
LAZY_REMOVE_MS: Final = 5000

# The retry budget of one token renewal: long enough to ride out a gateway restart or a rolling
# deploy, short enough that a user with no connectivity is told within seconds rather than a
# minute.
REFRESH_RETRY: Final = RetryPolicy(attempts=4, initial_delay_ms=500, max_delay_ms=4000)

# The LARGEST margin before expiry at which a token is proactively renewed. A ceiling, not the
# margin: the margin is half the token's own lifetime, capped here. A fixed margin can equal the
# lifetime an issuer mints (Keycloak's default is five minutes), which makes every renewal
# already due: an idle signed-in page then sends over a hundred token requests a second.
REFRESH_BEFORE_EXP_MS: Final = 300000

# The shortest the proactive renewal ever waits. A timer due now that reschedules itself on
# arrival is a closed loop; a floor makes that impossible, so even an issuer minting expired
# tokens gets one attempt per interval. Waiting is cheap here: a 401 still drives a renewal.
MIN_REFRESH_DELAY_MS: Final = 10000

# How long bus-driven invalidations of one cache key fold together (CACHE-SEMANTICS B19). The
# first runs at once; any more inside the window become one refetch at its end. Each refetch is
# a request the session's principal pays for, and another principal's bulk write invalidates an
# observed key once per event.
INVALIDATION_WINDOW_MS: Final = 1000

# How long a job a client is following may say nothing before the client asks for its status. A
# job's progress and its end reach the client as passing frames, which a dropped stream loses
# and nothing redelivers; `job:status-requested` is how a follower learns what it missed. Every
# frame of the job starts the wait again.
JOB_SILENCE_MS: Final = 10000

# How often a client asks for the status of a job that has been silent for `jobSilenceMs`, until
# the job says something or its status is an end.
JOB_STATUS_POLL_MS: Final = 5000

# The shortest a client waits, with a generation it follows saying nothing, before it asks for
# the job to be cancelled and gives up on it. A floor, so a job that never says anything at all
# is caught whatever its size.
GENERATION_STALL_FLOOR_MS: Final = 120000

# How long a followed generation may be silent for each token it was asked for. A generation
# says nothing while its model writes, so the wait grows with the length of what was asked: four
# thousand tokens allow five minutes. The floor applies below it.
GENERATION_STALL_PER_TOKEN_MS: Final = 75

# The length assumed of a generation whose request states no `maxTokens`: the worker's own
# ceiling for one. At this length the floor decides the wait.
GENERATION_STALL_ASSUMED_TOKENS_COUNT: Final = 500

# How long a delegated job a client's state is following may say nothing before that state says
# the job has gone quiet (`mark:delegate-timeout`). Not a deadline on the job: the job goes on,
# the state keeps following it, and a completion that arrives later still ends it. Above the
# worker's heartbeat, so reaching it means silence and not a long call.
DELEGATE_SILENCE_MS: Final = 180000

# How long a party that takes jobs waits for the answer to one claim (`job:claim`). A claim is
# answered at once, with a job or with nothing pending; one still unanswered here is given up
# and reported as a refusal, and the party asks again at its next idle moment.
JOB_CLAIM_TIMEOUT_MS: Final = 10000

# How long a held job may show no activity (its claim, a progress report, its settle) before
# whoever holds it calls it stalled. Not a limit on how long a job runs: one that keeps
# reporting is never stalled. The dispatcher's own sweep of running jobs is the backstop for a
# holder too wedged to notice.
HELD_JOB_STALL_MS: Final = 900000

# How often a party that holds a job looks at how long it has shown no activity.
HELD_JOB_STALL_CHECK_MS: Final = 60000

# How many times a worker asks for the anchored text of a PDF it has just yielded
# (`browse:anchored-text-requested`) before it gives up on anchoring that PDF's citations. The
# text is the Smelter's to derive and is not there the moment the resource is. Each ask is
# answered at once when the text is stored, and otherwise waits at the Archivist for the Smelter
# to say it has settled the content (`smelt:settled`) before it is answered that the text is not
# there yet. So the count bounds the whole wait, and a worker that reaches it completes the job
# with the resource and without the citations.
GENERATED_TEXT_ASKS_COUNT: Final = 8

# How long a pointer rests on an annotation before the viewer says it is hovered. Shorter, and a
# pointer crossing the page hovers everything on its way.
HOVER_DELAY_MS: Final = 150

# How long a search waits after its query last changed before it asks. A query still being typed
# is not asked for letter by letter.
SEARCH_DEBOUNCE_MS: Final = 250

# Every entry's name, as the table states it.
TIMING_NAMES: Final[tuple[str, ...]] = (
    "busRequestTimeoutMs",
    "emitTimeoutMs",
    "emitRetry",
    "httpRequestTimeoutMs",
    "reconnectMs",
    "maxReconnectMs",
    "degradedThresholdMs",
    "lingerMs",
    "seenEventIdsCount",
    "reconnectDebounceMs",
    "lazyRemoveMs",
    "refreshRetry",
    "refreshBeforeExpMs",
    "minRefreshDelayMs",
    "invalidationWindowMs",
    "jobSilenceMs",
    "jobStatusPollMs",
    "generationStallFloorMs",
    "generationStallPerTokenMs",
    "generationStallAssumedTokensCount",
    "delegateSilenceMs",
    "jobClaimTimeoutMs",
    "heldJobStallMs",
    "heldJobStallCheckMs",
    "generatedTextAsksCount",
    "hoverDelayMs",
    "searchDebounceMs",
)
