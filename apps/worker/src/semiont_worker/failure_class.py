"""The class a job's failure is reported in, and the failure the worker raises for what it knows cannot succeed again.

A deterministic failure is not retried, and neither is an answer the provider
withheld: the second attempt of the same request ends as the first did. Only
a failure known to be one of the two is called so. Calling a transient
failure either one halves reliability, where the reverse costs one wasted
attempt, so whatever is not recognized is left unclassified, and is retried.

A failure is classed here, in the worker, where it is still typed. By the
time the gateway has it, it is text. `specs/src/worker/failure-class-cases.json`
holds the rule.
"""

import asyncio
from typing import Final

from semiont.retry import RetryFacts, RetryRule
from semiont.types import FailureClass
from semiont_inference.interface import ProviderWithheldError, StructuredReadError, StructuredUnsupportedError

from semiont_worker.inference_call import InferenceTimeoutError


class DeterministicJobError(Exception):
    """A failure the worker knows cannot succeed on a second identical attempt.

    It is raised where the work itself is judged, and not the transport: a
    reply cut off despite the budget worked out for it, a media type with
    nothing to read.
    """


def _job(facts: RetryFacts) -> bool:
    return facts.status is not None and (facts.status in (408, 429) or facts.status >= 500)


JOB: Final = RetryRule("job", _job)
"""A job's retry budget, where not retrying discards paid work: the `job` rule of `specs/src/retry/cases.json`.

A status from 500 up is retried here where a boot pass refuses it, because
the alternative is throwing a long attempt away over one fault, and a retried
job takes its units up where their cursors stand. 408 is a timeout said
outright, and 429 the server saying not now.
"""


def classify_failure(failure: object) -> FailureClass | None:
    """The class `failure` is reported in on `job:fail`, or `None` where it is not classified.

    The rule is asked in this order, and the first part that answers decides:
    what the worker itself raised; what an inference driver raised of a
    generation, beside a status; the language's abort; a status the failure
    carries as a number; and anything else is left unclassified. No part
    reads the name a provider's library gives a failure.
    """
    # What the worker itself raised.
    if isinstance(failure, DeterministicJobError):
        return "deterministic"
    if isinstance(failure, InferenceTimeoutError):
        return "transient"

    # What an inference driver raised of a generation, beside a status.
    if isinstance(failure, StructuredUnsupportedError):
        # A model not known to hold a reply to a schema, refused with no request made: no attempt changes what is known of it.
        return "deterministic"
    if isinstance(failure, StructuredReadError):
        # Only `max_tokens` says the reply was cut off, and the same text is cut off the same way again.
        # Any other unreadable reply is left unclassified, and not called transient: a resumed unit cuts
        # the piece again at another size, so the next attempt reads other input, which is neither a
        # passing fault nor the same request.
        return "deterministic" if failure.stop_reason == "max_tokens" else None
    if isinstance(failure, ProviderWithheldError):
        return "withheld"

    # The language's abort: the worker's own bound or its stopping tore the call down, and nothing was judged.
    if isinstance(failure, asyncio.CancelledError):
        return "transient"

    # A status, where the failure carries one as a number: a driver's `ProviderStatusError` carries the one
    # its provider refused with, and the SDK's failure the one a gateway refused with. Which statuses are
    # worth another attempt is the job rule's to say. What is said here is the one thing the rule cannot
    # know: any other status of 400 or more is a request that was refused, and is refused again unchanged.
    status: object = getattr(failure, "status", None)
    if isinstance(status, int):
        if JOB.retryable(RetryFacts(status=status)):
            return "transient"
        if status >= 400:
            return "deterministic"

    # A connection that ended, a network failure, whatever reported it: unclassified, and so retried.
    return None
