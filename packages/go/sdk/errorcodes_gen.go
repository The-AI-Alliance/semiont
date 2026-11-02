// Code generated from specs/src/errors/codes.json — DO NOT EDIT.
//
// Regenerate: node packages/codegen/schemas/generate-error-codes-go.mjs
// The TypeScript and Python vocabularies are generated from the same table,
// and Rust's by its SDK's build script.

package semiont

import "github.com/The-AI-Alliance/semiont/packages/go/sdk/api"

// Why a bus request did not resolve. Some members restate a failure the
// answering peer declared on the wire (`wire` names its `CommandError.code`);
// the rest are facts only the requesting side knows, which is why this
// vocabulary and the wire's stay separate.
type BusRequestErrorCode string

const (
	// No reply arrived within the time the request allowed.
	BusRequestErrorCodeTimeout BusRequestErrorCode = "bus.timeout"
	// The peer answered with a failure whose code this vocabulary does not name,
	// or that states none.
	BusRequestErrorCodeRejected BusRequestErrorCode = "bus.rejected"
	// The bus stopped before a reply came: its client was disposed, or its
	// transport closed.
	BusRequestErrorCodeClosed BusRequestErrorCode = "bus.closed"
	// The peer says this resource does not exist in its knowledge base.
	BusRequestErrorCodeNotFound BusRequestErrorCode = "bus.not-found"
	// THIS transport is not subscribed to the reply channel: a local
	// misconfiguration, caught before emitting. Not to be confused with
	// `bus.peer-unavailable`, which is the opposite end.
	BusRequestErrorCodeUnsubscribed BusRequestErrorCode = "bus.unsubscribed"
	// The service that answers this channel is not connected. Transient by
	// nature, a peer still starting, and therefore the one failure on this list
	// worth retrying.
	BusRequestErrorCodePeerUnavailable BusRequestErrorCode = "bus.peer-unavailable"
	// The peer says this caller may not do what it asked: authenticated, not
	// permitted. Retrying under the same credential cannot succeed, so a
	// consumer surfaces it and never spins on it.
	BusRequestErrorCodeUnauthorized BusRequestErrorCode = "bus.unauthorized"
	// The peer declined and nothing went wrong: a `job:claim` found no pending
	// job of the requested types. The one member a consumer parks on.
	BusRequestErrorCodeNonePending BusRequestErrorCode = "bus.none-pending"
)

// BusRequestErrorCodeOfWire is the code a failure's own code
// (CommandError.code) becomes. A failure that states none, or one this
// vocabulary does not name, is BusRequestErrorCodeRejected.
func BusRequestErrorCodeOfWire(code *api.CommandErrorCode) BusRequestErrorCode {
	if code == nil {
		return BusRequestErrorCodeRejected
	}
	switch *code {
	case api.CommandErrorCodeNotFound:
		return BusRequestErrorCodeNotFound
	case api.CommandErrorCodePeerUnavailable:
		return BusRequestErrorCodePeerUnavailable
	case api.CommandErrorCodeUnauthorized:
		return BusRequestErrorCodeUnauthorized
	case api.CommandErrorCodeNonePending:
		return BusRequestErrorCodeNonePending
	default:
		return BusRequestErrorCodeRejected
	}
}

// Wire is the wire code a peer stated, when this code restates one: what a
// service answers its own caller with. A failure only this side knows states
// none, and ok is false.
func (c BusRequestErrorCode) Wire() (code api.CommandErrorCode, ok bool) {
	switch c {
	case BusRequestErrorCodeNotFound:
		return api.CommandErrorCodeNotFound, true
	case BusRequestErrorCodePeerUnavailable:
		return api.CommandErrorCodePeerUnavailable, true
	case BusRequestErrorCodeUnauthorized:
		return api.CommandErrorCodeUnauthorized, true
	case BusRequestErrorCodeNonePending:
		return api.CommandErrorCodeNonePending, true
	default:
		return "", false
	}
}

// Transport-neutral failure vocabulary. Every transport maps its native
// failures to one of these, so a routing layer matches on the code without
// knowing the wire kind. Over HTTP the mapping is by status: `status` is an
// exact status, `statusFrom` every status at or above it.
type TransportErrorCode string

const (
	// Authentication is required: the token is missing, expired, or refused. A
	// 429 whose `code` is `refusal-rate` refuses the token too, and is reported
	// as this code with its own status.
	TransportErrorCodeUnauthorized TransportErrorCode = "unauthorized"
	// Authenticated, and lacking permission.
	TransportErrorCodeForbidden TransportErrorCode = "forbidden"
	// The resource is missing.
	TransportErrorCodeNotFound TransportErrorCode = "not-found"
	// A concurrent modification, a duplicate, or another conflict with current
	// state.
	TransportErrorCodeConflict TransportErrorCode = "conflict"
	// The request is malformed.
	TransportErrorCodeBadRequest TransportErrorCode = "bad-request"
	// A limit refused it; the refusal's `Retry-After` says when to return.
	TransportErrorCodeRateLimited TransportErrorCode = "rate-limited"
	// The gateway is unreachable, the network failed, or the server answered
	// 5xx.
	TransportErrorCodeUnavailable TransportErrorCode = "unavailable"
	// A failure no other member names.
	TransportErrorCodeError TransportErrorCode = "error"
)

// TransportErrorCodeOfStatus is the code an HTTP status becomes.
func TransportErrorCodeOfStatus(status int) TransportErrorCode {
	switch {
	case status == 401:
		return TransportErrorCodeUnauthorized
	case status == 403:
		return TransportErrorCodeForbidden
	case status == 404:
		return TransportErrorCodeNotFound
	case status == 409:
		return TransportErrorCodeConflict
	case status == 400:
		return TransportErrorCodeBadRequest
	case status == 429:
		return TransportErrorCodeRateLimited
	case status >= 500:
		return TransportErrorCodeUnavailable
	default:
		return TransportErrorCodeError
	}
}

// Why a job its client follows ended without a result. A failure the queue
// will retry is not one of these: the job goes on, and its follower is told
// of the setback and keeps following.
type JobErrorCode string

const (
	// The job failed and will not be tried again: the failure its worker
	// reported, or the one its status states.
	JobErrorCodeFailed JobErrorCode = "job.failed"
	// The job was cancelled before it ended, as its status states. Nothing
	// announces a cancellation: its follower learns of it when it asks for the
	// job's status.
	JobErrorCodeCancelled JobErrorCode = "job.cancelled"
	// The job said nothing for longer than its follower allows. The follower has
	// asked for that job to be cancelled.
	JobErrorCodeStalled JobErrorCode = "job.stalled"
)

// Why a session itself is unusable. Per-request failures stay with their
// caller.
type SessionErrorCode string

const (
	// A session for the knowledge base could not be built or made ready.
	SessionErrorCodeConstructFailed SessionErrorCode = "session.construct-failed"
	// The stored credential could not be validated at startup, for a reason
	// other than the gateway refusing it.
	SessionErrorCodeAuthFailed SessionErrorCode = "session.auth-failed"
	// The session could not be renewed: the issuer refused, or stayed
	// unreachable until the retry budget was spent. Not a prompt to retry:
	// retrying already happened.
	SessionErrorCodeRefreshExhausted SessionErrorCode = "session.refresh-exhausted"
	// The gateway refused a token the issuer had just issued. The two disagree
	// about who may sign in, and renewing again cannot change the answer: the
	// session is over, and signing in again is what is left.
	SessionErrorCodeCredentialRefused SessionErrorCode = "session.credential-refused"
)

// Why a person could not be signed in at the issuer a knowledge base trusts,
// or a session could not be renewed there. Over the authorization-code grant,
// the device grant, the refresh grant and revocation alike.
type SignInErrorCode string

const (
	// The knowledge base trusts no external issuer: there is nowhere to sign in.
	SignInErrorCodeNoIssuer SignInErrorCode = "no-issuer"
	// The knowledge base did not say which issuer it trusts, or the issuer did
	// not describe itself, or described another issuer, or offers no endpoint
	// the grant needs.
	SignInErrorCodeDiscovery SignInErrorCode = "discovery"
	// A sign-in response arrived and no sign-in is pending here: it was
	// completed already, or begun somewhere else.
	SignInErrorCodeNoPending SignInErrorCode = "no-pending"
	// The sign-in response does not belong to the pending sign-in.
	SignInErrorCodeState SignInErrorCode = "state"
	// The person, or the issuer, refused the sign-in.
	SignInErrorCodeDenied SignInErrorCode = "denied"
	// The device code ran out before it was approved.
	SignInErrorCodeExpired SignInErrorCode = "expired"
	// The sign-in was abandoned by whoever began it.
	SignInErrorCodeAborted SignInErrorCode = "aborted"
	// The issuer refused a token request, a device authorization or a
	// revocation, or answered without what was asked for.
	SignInErrorCodeExchange SignInErrorCode = "exchange"
)

// Why a knowledge base that was reached with a fresh sign-in could not be
// registered: it has to say who it is, and nothing stands in for its answer.
type IdentityUnverifiableReason string

const (
	// The knowledge base was not reached, so it said nothing.
	IdentityUnverifiableReasonUnreachable IdentityUnverifiableReason = "unreachable"
	// The knowledge base answered that it cannot say what it is.
	IdentityUnverifiableReasonNotReported IdentityUnverifiableReason = "not-reported"
)

// Why no annotation was built of a span: the span is not the text's, or, for
// a PDF, is nowhere on its pages, or the PDF's anchored text does not hold
// together. specs/src/annotations/builder-cases.json holds when each is
// given.
type SpanRefusal string

const (
	// The span's offsets are not two whole numbers from 0, the second no less
	// than the first, within the text.
	SpanRefusalSpanOutOfRange SpanRefusal = "span-out-of-range"
	// The words the span states are not the text between its offsets.
	SpanRefusalExactMismatch SpanRefusal = "exact-mismatch"
	// The prefix the span states is not the text just before it.
	SpanRefusalPrefixMismatch SpanRefusal = "prefix-mismatch"
	// The suffix the span states is not the text just after it.
	SpanRefusalSuffixMismatch SpanRefusal = "suffix-mismatch"
	// No item of the PDF's anchored text holds any of the span, so it is nowhere
	// on a page.
	SpanRefusalNothingLocated SpanRefusal = "nothing-located"
	// The items of the PDF's anchored text that hold the span do not have its
	// words.
	SpanRefusalExactNotCovered SpanRefusal = "exact-not-covered"
	// An item of the PDF's anchored text is no stretch of that text: its offsets
	// are not two whole numbers from 0, the second no less than the first,
	// within the text. This one is said of the anchored text and not of the
	// span: the items are what say where the text is on a page, and no span is
	// built on an anchored text one of whose items cannot be.
	SpanRefusalItemOutOfRange SpanRefusal = "item-out-of-range"
)
