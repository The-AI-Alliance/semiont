# Generated from specs/src/errors/codes.json; do not edit.
# Regenerate: node scripts/spec/generate-error-codes-python.mjs

"""The codes a Semiont client reports a failure under.

Each vocabulary is a closed set: a `Literal` union, so a `match` over one that
ends in `assert_never` is checked to name every code, and a tuple of the same
codes to iterate.
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final, Literal

__all__ = [
    "BUS_REQUEST_CODE_BY_WIRE_CODE",
    "BUS_REQUEST_ERROR_CODES",
    "BusRequestErrorCode",
    "IDENTITY_UNVERIFIABLE_REASONS",
    "IdentityUnverifiableReason",
    "JOB_ERROR_CODES",
    "JobErrorCode",
    "SEMIONT_SESSION_ERROR_CODES",
    "SIGN_IN_ERROR_CODES",
    "SPAN_REFUSALS",
    "SemiontSessionErrorCode",
    "SignInErrorCode",
    "SpanRefusal",
    "TRANSPORT_ERROR_CODES",
    "TransportErrorCode",
    "UNRECOGNIZED_FAILURE_CODE",
    "transport_error_code_for_status",
]

# Why a bus request did not resolve. Some members restate a failure the answering peer declared
# on the wire (`wire` names its `CommandError.code`); the rest are facts only the requesting
# side knows, which is why this vocabulary and the wire's stay separate.
type BusRequestErrorCode = Literal[
    # No reply arrived within the time the request allowed.
    "bus.timeout",
    # The peer answered with a failure whose code this vocabulary does not name, or that states
    # none.
    "bus.rejected",
    # The bus stopped before a reply came: its client was disposed, or its transport closed.
    "bus.closed",
    # The peer says this resource does not exist in its knowledge base.
    "bus.not-found",
    # THIS transport is not subscribed to the reply channel: a local misconfiguration, caught
    # before emitting. Not to be confused with `bus.peer-unavailable`, which is the opposite
    # end.
    "bus.unsubscribed",
    # The service that answers this channel is not connected. Transient by nature, a peer still
    # starting, and therefore the one failure on this list worth retrying.
    "bus.peer-unavailable",
    # The peer says this caller may not do what it asked: authenticated, not permitted. Retrying
    # under the same credential cannot succeed, so a consumer surfaces it and never spins on it.
    "bus.unauthorized",
    # The peer declined and nothing went wrong: a `job:claim` found no pending job of the
    # requested types. The one member a consumer parks on.
    "bus.none-pending",
]

BUS_REQUEST_ERROR_CODES: Final[tuple[BusRequestErrorCode, ...]] = (
    "bus.timeout",
    "bus.rejected",
    "bus.closed",
    "bus.not-found",
    "bus.unsubscribed",
    "bus.peer-unavailable",
    "bus.unauthorized",
    "bus.none-pending",
)

# The bus code a failure's own wire code (`CommandError.code`) becomes.
BUS_REQUEST_CODE_BY_WIRE_CODE: Final[Mapping[str, BusRequestErrorCode]] = MappingProxyType(
    {
        "not-found": "bus.not-found",
        "peer-unavailable": "bus.peer-unavailable",
        "unauthorized": "bus.unauthorized",
        "none-pending": "bus.none-pending",
    }
)

# What a failure becomes when its code is one this vocabulary does not name, or absent.
UNRECOGNIZED_FAILURE_CODE: Final[BusRequestErrorCode] = "bus.rejected"

# Transport-neutral failure vocabulary. Every transport maps its native failures to one of
# these, so a routing layer matches on the code without knowing the wire kind. Over HTTP the
# mapping is by status: `status` is an exact status, `statusFrom` every status at or above it.
type TransportErrorCode = Literal[
    # Authentication is required: the token is missing or expired.
    "unauthorized",
    # Authenticated, and lacking permission.
    "forbidden",
    # The resource is missing.
    "not-found",
    # A concurrent modification, a duplicate, or another conflict with current state.
    "conflict",
    # The request is malformed.
    "bad-request",
    # A limit refused it; the refusal's `Retry-After` says when to return.
    "rate-limited",
    # The gateway is unreachable, the network failed, or the server answered 5xx.
    "unavailable",
    # A failure no other member names.
    "error",
]

TRANSPORT_ERROR_CODES: Final[tuple[TransportErrorCode, ...]] = (
    "unauthorized",
    "forbidden",
    "not-found",
    "conflict",
    "bad-request",
    "rate-limited",
    "unavailable",
    "error",
)


def transport_error_code_for_status(status: int) -> TransportErrorCode:
    """The transport code an HTTP status becomes."""
    match status:
        case 401:
            return "unauthorized"
        case 403:
            return "forbidden"
        case 404:
            return "not-found"
        case 409:
            return "conflict"
        case 400:
            return "bad-request"
        case 429:
            return "rate-limited"
        case _:
            pass
    if status >= 500:
        return "unavailable"
    return "error"


# Why a job its client follows ended without a result. A failure the queue will retry is not one
# of these: the job goes on, and its follower is told of the setback and keeps following.
type JobErrorCode = Literal[
    # The job failed and will not be tried again: the failure its worker reported, or the one
    # its status states.
    "job.failed",
    # The job was cancelled before it ended, as its status states. Nothing announces a
    # cancellation: its follower learns of it when it asks for the job's status.
    "job.cancelled",
    # The job said nothing for longer than its follower allows. The follower has asked for that
    # job to be cancelled.
    "job.stalled",
]

JOB_ERROR_CODES: Final[tuple[JobErrorCode, ...]] = (
    "job.failed",
    "job.cancelled",
    "job.stalled",
)

# Why a session itself is unusable. Per-request failures stay with their caller.
type SemiontSessionErrorCode = Literal[
    # A session for the knowledge base could not be built or made ready.
    "session.construct-failed",
    # The stored credential could not be validated at startup, for a reason other than the
    # gateway refusing it.
    "session.auth-failed",
    # The session could not be renewed: the issuer refused, or stayed unreachable until the
    # retry budget was spent. Not a prompt to retry: retrying already happened.
    "session.refresh-exhausted",
    # The gateway refused a token the issuer had just issued. The two disagree about who may
    # sign in, and renewing again cannot change the answer: the session is over, and signing in
    # again is what is left.
    "session.credential-refused",
]

SEMIONT_SESSION_ERROR_CODES: Final[tuple[SemiontSessionErrorCode, ...]] = (
    "session.construct-failed",
    "session.auth-failed",
    "session.refresh-exhausted",
    "session.credential-refused",
)

# Why a person could not be signed in at the issuer a knowledge base trusts, or a session could
# not be renewed there. Over the authorization-code grant, the device grant, the refresh grant
# and revocation alike.
type SignInErrorCode = Literal[
    # The knowledge base trusts no external issuer: there is nowhere to sign in.
    "no-issuer",
    # The knowledge base did not say which issuer it trusts, or the issuer did not describe
    # itself, or described another issuer, or offers no endpoint the grant needs.
    "discovery",
    # A sign-in response arrived and no sign-in is pending here: it was completed already, or
    # begun somewhere else.
    "no-pending",
    # The sign-in response does not belong to the pending sign-in.
    "state",
    # The person, or the issuer, refused the sign-in.
    "denied",
    # The device code ran out before it was approved.
    "expired",
    # The sign-in was abandoned by whoever began it.
    "aborted",
    # The issuer refused a token request, a device authorization or a revocation, or answered
    # without what was asked for.
    "exchange",
]

SIGN_IN_ERROR_CODES: Final[tuple[SignInErrorCode, ...]] = (
    "no-issuer",
    "discovery",
    "no-pending",
    "state",
    "denied",
    "expired",
    "aborted",
    "exchange",
)

# Why a knowledge base that was reached with a fresh sign-in could not be registered: it has to
# say who it is, and nothing stands in for its answer.
type IdentityUnverifiableReason = Literal[
    # The knowledge base was not reached, so it said nothing.
    "unreachable",
    # The knowledge base answered that it cannot say what it is.
    "not-reported",
]

IDENTITY_UNVERIFIABLE_REASONS: Final[tuple[IdentityUnverifiableReason, ...]] = (
    "unreachable",
    "not-reported",
)

# Why no annotation was built of a span: the span is not the text's, or, for a PDF, is nowhere
# on its pages. specs/src/annotations/builder-cases.json holds when each is given.
type SpanRefusal = Literal[
    # The span's offsets are not two whole numbers from 0, the second no less than the first,
    # within the text.
    "span-out-of-range",
    # The words the span states are not the text between its offsets.
    "exact-mismatch",
    # The prefix the span states is not the text just before it.
    "prefix-mismatch",
    # The suffix the span states is not the text just after it.
    "suffix-mismatch",
    # No item of the PDF's anchored text holds any of the span, so it is nowhere on a page.
    "nothing-located",
    # The items of the PDF's anchored text that hold the span do not have its words.
    "exact-not-covered",
]

SPAN_REFUSALS: Final[tuple[SpanRefusal, ...]] = (
    "span-out-of-range",
    "exact-mismatch",
    "prefix-mismatch",
    "suffix-mismatch",
    "nothing-located",
    "exact-not-covered",
)
