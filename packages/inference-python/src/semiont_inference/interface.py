"""What a service calls to ask a model something: the client every driver is, what it answers, and how it fails."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol, final

from pydantic import JsonValue

__all__ = [
    "ElementSchema",
    "InferenceClient",
    "InferenceLimits",
    "InferenceResponse",
    "ProviderStatusError",
    "ProviderWithheldError",
    "StructuredReadError",
    "StructuredResponse",
    "StructuredUnsupportedError",
    "TokenUsage",
]


@final
@dataclass(frozen=True, slots=True)
class TokenUsage:
    """What a call cost, as the provider counted it. It is never estimated here.

    Where a provider reports no counts an answer carries `None` in its place:
    not known is to be read as not known, and no guess stands in for it.
    """

    input_tokens: int
    output_tokens: int


@final
@dataclass(frozen=True, slots=True)
class InferenceResponse:
    """A model's text, and why it stopped: `end_turn`, `max_tokens`, `stop_sequence`, or another word of the provider's."""

    text: str
    stop_reason: str
    usage: TokenUsage | None


type ElementSchema = Mapping[str, JsonValue]
"""The JSON Schema of one element of a structured generation's array.

It is the schema and nothing built around it. Most providers take JSON Schema
as it is. OpenAI's strict mode does not, and its driver sends the schema
rewritten and reads the answer back, so that an element reads the same
whichever provider wrote it. Keep to what every provider holds a reply to:
objects, `string`, `number`, `boolean` and `null`, an `enum` of text or of
numbers, `required`, and `additionalProperties: false`. Google's API holds a
reply to no `const`, and to no `enum` of anything else, and its driver
refuses a schema that states one. A bound on a number or on a text's length
(`minimum`, `maxLength`) is not held by Anthropic, is refused by every driver
but Anthropic's and Ollama's, and stating one misleads whoever reads the
schema.
"""


@final
@dataclass(frozen=True, slots=True)
class StructuredResponse:
    """A structured generation's result: the elements the model wrote, as parsed, and why it stopped.

    `items` is always the array. There is no value that means "here is text
    that could not be read": a driver that cannot deliver the array raises,
    so a failure is never taken for an empty result. A caller reads
    `stop_reason` too: `max_tokens` is a reply that was cut off, which is
    lost data and not fewer items.

    Nothing here checks an element against the schema it was asked with. The
    caller keeps its own check of each element beside the schema it states.
    """

    items: list[JsonValue]
    stop_reason: str
    usage: TokenUsage | None


@final
@dataclass(frozen=True, slots=True)
class InferenceLimits:
    """A model's ceilings, as its provider states them. None is a constant kept by hand.

    `context_tokens` is the context window, and `max_output_tokens` the most
    the model writes. Who states them differs by provider:

    - Anthropic and Google state the most a model reads, and a ceiling of its
      own on what it writes.
    - Ollama, vLLM and llama.cpp's server state one window shared by both,
      and it is given here as both: `max_output_tokens == context_tokens`
      says the window is shared.
    - OpenAI's API states neither, so its driver is handed them, as a model
      catalogue states them: the whole window, which what is read and what is
      written share, and a ceiling of its own on what is written.
    - Together states a model's window in its model list, and no ceiling on
      what the model writes. Its driver asks for the window and is handed the
      ceiling, as a model catalogue states it, and never states the ceiling
      above the window. Where the list states no window for a model, the
      window too is the catalogue's.

    `output_tokens_per_hour` is the provider's own worst-case rate, where it
    states one. Anthropic's library reckons a call's longest duration from it
    and refuses to wait for a whole answer reckoned at over ten minutes. A
    caller with a deadline of its own works out from it how much to ask for.
    `None` is a provider whose rate cannot be known beforehand (Ollama, vLLM
    and llama.cpp's server: the hardware is the operator's; OpenAI, Google
    and Together: they state none). It does not mean a call has no bound.

    `accepts_temperature` is whether the model takes a caller's temperature.
    Some Anthropic models refuse any, so the Anthropic driver asks at
    discovery and leaves the parameter out for one that does. The OpenAI,
    Google and Together drivers leave it out wherever this is not `True`.
    `None` is no claim: only `False` says the model refuses it.
    """

    context_tokens: int
    max_output_tokens: int
    output_tokens_per_hour: int | None
    accepts_temperature: bool | None


@final
class StructuredReadError(Exception):
    """A reply that could not be read as the array asked for, or that came back empty.

    It is never turned into an empty array: empty is an answer of its own.
    Every driver raises this one failure, so that what a worker decides by it
    does not depend on the provider.

    `stop_reason` is the provider's. `max_tokens` is a reply cut off by the
    budget: the same request is cut off the same way again, so asking again
    is wasted. Any other reason is a model that misbehaved, and asking again
    may get an answer. An empty reply is one of these too: a model that
    reasons out of sight can spend the whole budget before the first
    character of its answer.
    """

    def __init__(self, detail: str, stop_reason: str) -> None:
        super().__init__(f"Structured response could not be read: {detail} (stop_reason: {stop_reason})")
        self.stop_reason = stop_reason


@final
class StructuredUnsupportedError(Exception):
    """A structured generation asked of a model not known to hold a reply to a schema.

    It is the counterpart of `StructuredReadError`, raised before any
    generation is asked for. A generation the provider does not hold to the
    schema can come back unreadable, and an unreadable reply taken for an
    empty one completes a job that found nothing, so a driver refuses rather
    than ask. Every driver that refuses such a generation raises this one
    failure.

    No attempt changes what is known of the model, so asking again is wasted.
    The message is the driver's own, and names the model. The failure carries
    nothing else: whoever catches it holds the client, which says its model.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)


@final
class ProviderStatusError(Exception):
    """The provider answered a request with an HTTP status that refuses it.

    The request is a generation, or a discovery: `limits`, and whatever a
    driver learns with it. Every driver raises this one failure: `status` is
    what a caller decides a retry by, and it does not depend on which
    provider's library reported the refusal, or on whether there is a library
    at all.

    A refused discovery says in its message what was being learned and the
    status. A discovery that fails with no status (a connection that ended,
    an answer that does not state what was asked, a model a list does not
    have) is not one of these: it raises a plain error, with what failed as
    its cause where something did.
    """

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


@final
class ProviderWithheldError(Exception):
    """The provider withheld its answer.

    It had the request, and chose to give no answer, or to end one it had
    begun: a refusal, a content filter. Every driver raises this one failure.
    Whatever the reply carried is no answer, and is not passed on: a caller
    that got it as text would keep a refusal as a document.

    `reason` is the provider's own word for what it did, as it stated it.
    """

    def __init__(self, detail: str, reason: str) -> None:
        super().__init__(f"The provider withheld its answer: {detail}")
        self.reason = reason


class InferenceClient(Protocol):
    """One provider's model, as a service asks things of it.

    **What a generation raises** is part of this, so a caller tells failures
    apart without knowing its provider and without importing a provider's
    library: a `ProviderStatusError`, when the provider refused with an HTTP
    status, the generation itself or a discovery it waited on; a
    `StructuredUnsupportedError`, when a structured generation is asked of a
    model not known to hold a reply to a schema; a `StructuredReadError`,
    when the reply cannot be read as what was asked for, or is empty; a
    `ProviderWithheldError`, when the provider withheld its answer; and
    anything else as it came, a connection that ended or a network failure.

    **Cancelling.** No method takes a signal. A call is cancelled by
    cancelling the task that awaits it: the request to the provider is torn
    down, and `asyncio.CancelledError` reaches the caller as it is. A driver
    never shields a generation from its caller's cancellation, never swallows
    one, and never raises anything else in its place. What a driver learns
    once for every caller (its limits) is not one caller's to end: a caller
    cancelled while it waits for that leaves at once, and the others still
    get it.
    """

    @property
    def provider(self) -> str:
        """The provider's name, as a knowledge base's config has it: `anthropic`, `ollama`."""
        ...

    @property
    def model_id(self) -> str:
        """The model asked, as the provider names it."""
        ...

    @property
    def max_concurrency(self) -> int:
        """How many independent calls a caller should run at once against this provider.

        It is the provider's to state, and has no value that is right for
        all of them. A hosted API whose rate limit is far above one job's use
        has room, and more than one call at once is faster. One local model
        has none: its speed is its hardware's, calls made at once only queue,
        and each holds memory.
        """
        ...

    @property
    def verify_detection_yield(self) -> bool:
        """Whether a detection's extractions are to be checked against a count the model is asked for.

        True of every real provider: an extraction that finds under half of
        what is counted has quietly lost its yield. It is stated here because
        a worker does nothing by provider: what differs between providers is
        said by the client.
        """
        ...

    async def limits(self) -> InferenceLimits:
        """The model's ceilings, asked of the provider at the first call and kept.

        A discovery that fails is not kept, and the next call asks again. It
        raises when the ceilings cannot be learned, and there is no guessed
        value to fall back on: a `ProviderStatusError` when the provider
        refused with an HTTP status (a wrong key, a model the provider does
        not have, a provider that is overloaded), and a plain error when
        there was no status (a provider that cannot be reached, an answer
        that states no ceilings). A driver whose provider cannot be asked
        (the OpenAI driver) answers what it was handed when it was made, and
        asks nothing.
        """
        ...

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        """The model's answer to `prompt`, in at most `max_tokens` tokens: its text, why it stopped, and what it cost."""
        ...

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        """A JSON array whose elements the provider held to `element_schema`, as parsed values.

        The answer is the array or a failure. A reply that is not valid JSON,
        or is JSON and not an array, raises a `StructuredReadError`. It is
        never an empty array in the reply's place. A model not known to hold
        a reply to a schema raises a `StructuredUnsupportedError`, and no
        generation is asked for.
        """
        ...
