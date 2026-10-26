// Code generated from specs/src/client/timing.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-client-timing-go.mjs
// The TypeScript and Python constants are generated from the same table, and
// Rust's by its SDK's build script.

package semiont

import "time"

// Timing is the timing a Semiont client keeps: its deadlines, its retry
// budgets, the cadence of its stream, and what it keeps count of, as
// specs/src/client/timing.json states them for every SDK. It holds one field
// per entry, under the entry's name. DefaultTiming is the table's values; a
// caller that wants another sets that field.
type Timing struct {
	// BusRequestTimeout is busRequestTimeoutMs: How long a bus request waits for
	// its reply. The gateway keeps a reply for redelivery at least twice this
	// long (`replyRetentionSeconds` on POST /bus/subscribe), so a reply
	// published during an outage is still there when the requester reconnects
	// inside its own deadline.
	BusRequestTimeout time.Duration
	// EmitTimeout is emitTimeoutMs: The deadline on one POST /bus/emit. The
	// gateway accepts an emit promptly; one still unanswered here means the
	// gateway is unresponsive, and the emit is rejected rather than awaited
	// forever. Without it a worker's emit to a wedged gateway hangs its loop.
	EmitTimeout time.Duration
	// EmitRetry is emitRetry: The retry budget of ONE emit. Per request, never
	// per boot pass: re-running a whole catch-up pass to recover from one
	// refusal re-sends hundreds of emits that already succeeded. Small on
	// purpose: an emit a caller awaits must fail while the caller still cares,
	// and the patience for a gateway that is down belongs to the pass above it.
	EmitRetry RetryPolicy
	// HttpRequestTimeout is httpRequestTimeoutMs: The deadline on one HTTP
	// request that is neither the stream nor an emit: one of the gateway's own
	// operations (who a token is, a media token, an agent's token, the resource
	// metadata, health, status), the wait for a resource's bytes to begin
	// arriving, a read of a resource's description or of its anchored text, a
	// request to the issuer (its discovery, a grant, a revocation), and a read
	// of a launcher's discovery document. Unanswered here, the request fails as
	// one that got no answer. Without it, a gateway or an issuer that accepts a
	// connection and never answers holds a session's start, and every renewal
	// after it, for as long as the process lives. An upload has no deadline: how
	// long it takes is how large the resource is. A read of anchored text may be
	// held by the Archivist while the Smelter reads the content, for the time
	// docs/protocol/ARCHIVIST.md states, and this deadline is longer than that
	// wait.
	HttpRequestTimeout time.Duration
	// RequestRetryPause is requestRetryPauseMs: The wait before an HTTP request
	// that is neither the stream nor an emit is made a second time. It is made
	// again when the gateway answered it with a status that promises recovery,
	// or did not answer at all, on a method that cannot cause a second effect
	// (`transport` in specs/src/retry/cases.json); once, after this wait, or
	// after a refusal's `Retry-After` when that is longer. A request whose
	// credential was refused is renewed and sent again at once, without this
	// wait, and one unanswered at its deadline (`httpRequestTimeoutMs`) is not
	// made again.
	RequestRetryPause time.Duration
	// Reconnect is reconnectMs: The first wait before a failed stream is opened
	// again. Each further failure doubles it, up to `maxReconnectMs`, and a
	// successful open resets it. Also the cadence at which a transport with no
	// usable credential checks for one, which costs no request.
	Reconnect time.Duration
	// MaxReconnect is maxReconnectMs: The ceiling of the reconnect backoff: a
	// long outage settles at about one attempt a minute instead of growing
	// without bound.
	MaxReconnect time.Duration
	// DegradedThreshold is degradedThresholdMs: How long a stream may be
	// reconnecting before its state becomes degraded.
	DegradedThreshold time.Duration
	// Linger is lingerMs: How long a superseded connection keeps draining after
	// a make-before-break handoff. Closing it the instant its replacement opens
	// discards replies already written to the old socket and not yet read. The
	// overlap doubles nothing: a frame both connections carry has one id, and is
	// delivered once (`seenEventIdsCount`).
	Linger time.Duration
	// SeenEventIdsCount is seenEventIdsCount: How many of the event ids it
	// delivered last a client remembers. A frame whose id is among them is one
	// it has delivered already, and is dropped: that is what makes a frame
	// carried by both streams of a handoff, or replayed to the new one, arrive
	// once. A client that remembers fewer delivers twice whenever more than that
	// many events pass between the two copies.
	SeenEventIdsCount int
	// ReconnectDebounce is reconnectDebounceMs: How long additions to the
	// subscription are gathered before the stream is reopened with them. Short,
	// because a new scope needs to be live now.
	ReconnectDebounce time.Duration
	// LazyRemove is lazyRemoveMs: How long a removal from the subscription waits
	// before the stream is reopened without it. Removal only narrows delivery,
	// and reopening on every scope a viewer brushes past would churn the
	// connection.
	LazyRemove time.Duration
	// RefreshRetry is refreshRetry: The retry budget of one token renewal: long
	// enough to ride out a gateway restart or a rolling deploy, short enough
	// that a user with no connectivity is told within seconds rather than a
	// minute.
	RefreshRetry RetryPolicy
	// RefreshBeforeExp is refreshBeforeExpMs: The LARGEST margin before expiry
	// at which a token is proactively renewed. A ceiling, not the margin: the
	// margin is half the token's own lifetime, capped here. A fixed margin can
	// equal the lifetime an issuer mints (Keycloak's default is five minutes),
	// which makes every renewal already due: an idle signed-in page then sends
	// over a hundred token requests a second.
	RefreshBeforeExp time.Duration
	// MinRefreshDelay is minRefreshDelayMs: The shortest the proactive renewal
	// ever waits. A timer due now that reschedules itself on arrival is a closed
	// loop; a floor makes that impossible, so even an issuer minting expired
	// tokens gets one attempt per interval. Waiting is cheap here: a 401 still
	// drives a renewal.
	MinRefreshDelay time.Duration
	// InvalidationWindow is invalidationWindowMs: How long bus-driven
	// invalidations of one cache key fold together (CACHE-SEMANTICS B19). The
	// first runs at once; any more inside the window become one refetch at its
	// end. Each refetch is a request the session's principal pays for, and
	// another principal's bulk write invalidates an observed key once per event.
	InvalidationWindow time.Duration
	// JobSilence is jobSilenceMs: How long a job a client is following may say
	// nothing before the client asks for its status. A job's progress and its
	// end reach the client as passing frames, which a dropped stream loses and
	// nothing redelivers; `job:status-requested` is how a follower learns what
	// it missed. Every frame of the job starts the wait again.
	JobSilence time.Duration
	// JobStatusPoll is jobStatusPollMs: How often a client asks for the status
	// of a job that has been silent for `jobSilenceMs`, until the job says
	// something or its status is an end.
	JobStatusPoll time.Duration
	// GenerationStallFloor is generationStallFloorMs: The shortest a client
	// waits, with a generation it follows saying nothing, before it asks for the
	// job to be cancelled and gives up on it. A floor, so a job that never says
	// anything at all is caught whatever its size.
	GenerationStallFloor time.Duration
	// GenerationStallPerToken is generationStallPerTokenMs: How long a followed
	// generation may be silent for each token it was asked for. A generation
	// says nothing while its model writes, so the wait grows with the length of
	// what was asked: four thousand tokens allow five minutes. The floor applies
	// below it.
	GenerationStallPerToken time.Duration
	// GenerationStallAssumedTokensCount is generationStallAssumedTokensCount:
	// The length assumed of a generation whose request states no `maxTokens`:
	// the worker's own ceiling for one. At this length the floor decides the
	// wait.
	GenerationStallAssumedTokensCount int
	// DelegateSilence is delegateSilenceMs: How long a delegated job a client's
	// state is following may say nothing before that state says the job has gone
	// quiet (`mark:delegate-timeout`). Not a deadline on the job: the job goes
	// on, the state keeps following it, and a completion that arrives later
	// still ends it. Above the worker's heartbeat, so reaching it means silence
	// and not a long call.
	DelegateSilence time.Duration
	// JobClaimTimeout is jobClaimTimeoutMs: How long a party that takes jobs
	// waits for the answer to one claim (`job:claim`). A claim is answered at
	// once, with a job or with nothing pending; one still unanswered here is
	// given up and reported as a refusal, and the party asks again at its next
	// idle moment.
	JobClaimTimeout time.Duration
	// HeldJobStall is heldJobStallMs: How long a held job may show no activity
	// (its claim, a progress report, its settle) before whoever holds it calls
	// it stalled. Not a limit on how long a job runs: one that keeps reporting
	// is never stalled. The dispatcher's own sweep of running jobs is the
	// backstop for a holder too wedged to notice.
	HeldJobStall time.Duration
	// HeldJobStallCheck is heldJobStallCheckMs: How often a party that holds a
	// job looks at how long it has shown no activity.
	HeldJobStallCheck time.Duration
	// MarkCommitTimeout is markCommitTimeoutMs: How long a worker waits for the
	// record to acknowledge a commit of annotations (`mark:commit`), and then,
	// when no acknowledgement came, for the answer to its question whether the
	// batch's last annotation is on the resource
	// (`browse:annotation-requested`). Generous beside an append, since a batch
	// is a unit's annotations and the record may be catching up, and finite,
	// since a wait on an acknowledgement that never comes would hold the job
	// forever.
	MarkCommitTimeout time.Duration
	// GeneratedTextAsksCount is generatedTextAsksCount: How many times a worker
	// asks for the anchored text of a PDF it has just yielded (`GET
	// /resources/{id}/anchored-text`) before it gives up on anchoring that PDF's
	// citations. The text is the Smelter's to derive and is not there the moment
	// the resource is. Each ask is answered at once when the text is stored, and
	// otherwise waits at the Archivist for the Smelter to say it has settled the
	// content (`smelt:settled`) before it is answered that the text is not there
	// yet. So the count bounds the whole wait, and a worker that reaches it
	// completes the job with the resource and without the citations.
	GeneratedTextAsksCount int
	// AnchoredTextReask is anchoredTextReaskMs: How long a viewer waits before
	// it asks again for a resource's anchored text (`GET
	// /resources/{id}/anchored-text`), after an answer that the text is not
	// there yet or an ask that got no answer. The Archivist holds an ask while
	// the Smelter reads the content and answers as soon as it has, so this wait
	// is only for the answers that come at once: a text that is not there and is
	// not being read, and a failure. A viewer does not annotate a resource until
	// it holds the resource's text.
	AnchoredTextReask time.Duration
	// HoverDelay is hoverDelayMs: How long a pointer rests on an annotation
	// before the viewer says it is hovered. Shorter, and a pointer crossing the
	// page hovers everything on its way.
	HoverDelay time.Duration
	// SearchDebounce is searchDebounceMs: How long a search waits after its
	// query last changed before it asks. A query still being typed is not asked
	// for letter by letter.
	SearchDebounce time.Duration
}

// DefaultTiming is the table's values.
func DefaultTiming() Timing {
	return Timing{
		BusRequestTimeout:                 30000 * time.Millisecond,
		EmitTimeout:                       30000 * time.Millisecond,
		EmitRetry:                         RetryPolicy{Attempts: 4, InitialDelay: 1000 * time.Millisecond, MaxDelay: 4000 * time.Millisecond},
		HttpRequestTimeout:                30000 * time.Millisecond,
		RequestRetryPause:                 300 * time.Millisecond,
		Reconnect:                         5000 * time.Millisecond,
		MaxReconnect:                      60000 * time.Millisecond,
		DegradedThreshold:                 3000 * time.Millisecond,
		Linger:                            1000 * time.Millisecond,
		SeenEventIdsCount:                 512,
		ReconnectDebounce:                 100 * time.Millisecond,
		LazyRemove:                        5000 * time.Millisecond,
		RefreshRetry:                      RetryPolicy{Attempts: 4, InitialDelay: 500 * time.Millisecond, MaxDelay: 4000 * time.Millisecond},
		RefreshBeforeExp:                  300000 * time.Millisecond,
		MinRefreshDelay:                   10000 * time.Millisecond,
		InvalidationWindow:                1000 * time.Millisecond,
		JobSilence:                        10000 * time.Millisecond,
		JobStatusPoll:                     5000 * time.Millisecond,
		GenerationStallFloor:              120000 * time.Millisecond,
		GenerationStallPerToken:           75 * time.Millisecond,
		GenerationStallAssumedTokensCount: 500,
		DelegateSilence:                   180000 * time.Millisecond,
		JobClaimTimeout:                   10000 * time.Millisecond,
		HeldJobStall:                      900000 * time.Millisecond,
		HeldJobStallCheck:                 60000 * time.Millisecond,
		MarkCommitTimeout:                 60000 * time.Millisecond,
		GeneratedTextAsksCount:            8,
		AnchoredTextReask:                 5000 * time.Millisecond,
		HoverDelay:                        150 * time.Millisecond,
		SearchDebounce:                    250 * time.Millisecond,
	}
}
