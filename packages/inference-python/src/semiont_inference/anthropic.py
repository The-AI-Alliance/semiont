"""The Anthropic driver: a Claude model, asked through Anthropic's own library.

The library is not a dependency of this package. It comes with the extra
`semiont-inference[anthropic]`, and this module is the one place it is
imported: whoever does not ask for this driver does not need it.

What this driver leans on in the library (`anthropic`, read at 1.13.0), so
that a new release of it is read for the same:

- It refuses to wait for a whole answer it reckons could take over ten
  minutes, at 128,000 tokens an hour (`_calculate_nonstreaming_timeout`).
  `_OUTPUT_TOKENS_PER_HOUR` below is that rate, and `tests/test_anthropic.py`
  asks the library where its refusal begins.
- It has no `temperature` parameter. A request's temperature goes in
  `extra_body`, which the library merges into the body it sends.
- It tries a request again, `max_retries` times, when the connection fails
  or the provider answers 408, 409, 429 or 500 and above, waiting as long as
  a `retry-after` header says.
- It builds a reply into typed models without checking it, so a member its
  types promise can be absent.
- Its failures: `APIStatusError` carries the status the provider refused
  with; `APIConnectionError` carries none. It has no failure of its own for a
  call that was cancelled, and catches no cancellation.
"""

import re
import time
from dataclasses import dataclass
from typing import Final, Literal, final

from pydantic import JsonValue, TypeAdapter

from semiont_inference._log import LOG
from semiont_inference._once import Once
from semiont_inference._structured import read_array
from semiont_inference._telemetry import record
from semiont_inference.interface import (
    ElementSchema,
    InferenceLimits,
    InferenceResponse,
    ProviderStatusError,
    ProviderWithheldError,
    StructuredReadError,
    StructuredResponse,
    TokenUsage,
)

try:
    from anthropic import APIStatusError, AsyncAnthropic, Omit, omit
    from anthropic.types import Message, ModelInfo, OutputConfigParam
except ModuleNotFoundError as missing:
    # A module the library itself lacks is another failure, and is left as it is.
    if missing.name != "anthropic":
        raise
    raise ModuleNotFoundError(
        "The Anthropic driver needs Anthropic's `anthropic` library, which is not installed. "
        "It comes with the extra: install `semiont-inference[anthropic]`.",
        name="anthropic",
    ) from missing

__all__ = ["AnthropicInferenceClient"]

_OBJECT: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])

# The library's own worst-case rate: it reckons a call's longest duration as an
# hour for every 128,000 tokens asked for, and refuses to wait for a whole answer
# reckoned at over ten minutes. One number, used twice: for when to ask for a
# stream, below, and as `limits().output_tokens_per_hour`, the one thing this
# provider says of how long a call takes, from which a detection works out how
# much to ask for.
_OUTPUT_TOKENS_PER_HOUR: Final = 128_000

# Ten minutes at that rate: 21,333 tokens. Above it the answer is asked for as a
# stream and put together here: the same request, the same reading of the reply.
_NONSTREAMING_MAX_OUTPUT_TOKENS: Final = _OUTPUT_TOKENS_PER_HOUR // 6

# What the probe asks for. It is also how a probe is told from a generation, in a
# test and in a log: nothing else asks for a single token.
_TEMPERATURE_PROBE_MAX_TOKENS: Final = 1

# How many times the library asks again for a request that failed. Chosen, and
# not left to the library: two is its default today, and written here a release
# of the library cannot change it unnoticed.
#
# Two is right on what was measured. A failure that comes quickly (a 429, a 409,
# a quick 5xx) costs seconds, the library waits as long as `retry-after` says,
# and 429 is the answer to expect when several entity types are asked about at
# once. A call that hangs never reaches a second try: the worker bounds the whole
# call, and that bound ends it during the first.
#
# What would change it: a call that generates for minutes and then fails, again
# and again. Its tries together can outlast the worker's bound, which the worker
# reads as a text too large and answers by cutting it smaller, and a smaller text
# does not mend a failing server. That has not been seen. If it is, lower this
# number.
_MAX_RETRIES: Final = 2

# The tokens the provider says it read and wrote, each where it said so.
type _Counts = tuple[int | None, int | None]


@final
@dataclass(frozen=True, slots=True)
class _Discovery:
    """What is learned of the model, once.

    Its ceilings and whether it answers in a schema come from one request of
    the Models API. Whether it takes a temperature comes from one request
    that sends it one.
    """

    limits: InferenceLimits
    structured_outputs_supported: bool
    temperature_accepted: bool


def _said(model: Message | ModelInfo) -> dict[str, JsonValue]:
    """What the provider sent, as the JSON it was.

    The library builds a reply into its typed models without checking it, so
    a member a type says is always there can be absent. What may be absent is
    read from here, by what is there.
    """
    return _OBJECT.validate_python(model.to_dict(mode="json"))


def _count(value: JsonValue) -> int | None:
    """A count of tokens, where `value` is one."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _counts(message: Message) -> _Counts:
    usage = _said(message).get("usage")
    if not isinstance(usage, dict):
        return None, None
    return _count(usage.get("input_tokens")), _count(usage.get("output_tokens"))


def _usage(counts: _Counts) -> TokenUsage | None:
    """The provider's two counts as a usage, or None where it did not report both.

    Never a zero in a count's place: that would say the call cost nothing,
    which is another claim than not knowing.
    """
    input_tokens, output_tokens = counts
    return None if input_tokens is None or output_tokens is None else TokenUsage(input_tokens=input_tokens, output_tokens=output_tokens)


@final
class AnthropicInferenceClient:
    """The model `model` of the Anthropic API at `base_url`, asked with `api_key`."""

    def __init__(self, *, api_key: str, model: str, base_url: str) -> None:
        self.provider: Final = "anthropic"
        self.model_id: Final = model
        # A hosted API: one detection job uses a sliver of an account's rate limit (about a
        # request every 72 seconds, and no 429 with four types at once), so independent calls
        # are faster together. Nothing above four at once has been measured.
        self.max_concurrency: Final = 4
        # True of every real provider. That no lost yield has been seen here is not having
        # looked, and reading the text twice is the price of looking.
        self.verify_detection_yield: Final = True
        self._api_key: Final = api_key
        self._base_url: Final = base_url
        self._discovery: Final = Once(self._discover)

    async def limits(self) -> InferenceLimits:
        return (await self._discovery.get()).limits

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        LOG.debug(
            "Generating text with inference client",
            extra={"model": self.model_id, "promptLength": len(prompt), "maxTokens": max_tokens, "temperature": temperature},
        )
        # A model that refuses a temperature answers 400 to any, and its callers go on stating
        # one. So it is left out here, once, and `limits().accepts_temperature` says that it is.
        discovery = await self._discovery.get()
        started = time.perf_counter()
        message, request_id = await self._recorded(
            started, prompt, max_tokens, temperature if discovery.temperature_accepted else None, omit
        )

        counts = _counts(message)
        text = self._answer(started, message, counts)
        self._record(started, "success", counts)
        LOG.info(
            "Text generation completed",
            extra={"model": self.model_id, "textLength": len(text), "stopReason": message.stop_reason, "requestId": request_id},
        )
        return InferenceResponse(text=text, stop_reason=message.stop_reason or "unknown", usage=_usage(counts))

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        # Which model is asked is a matter of config, so the provider is asked whether this one
        # holds a reply to a schema, and one that does not say so is refused. A generation held
        # to nothing can come back unreadable, and an unreadable reply taken for an empty one
        # completes a job that found nothing. It is the same discovery `limits()` makes.
        discovery = await self._discovery.get()
        if not discovery.structured_outputs_supported:
            raise RuntimeError(
                f"Model '{self.model_id}' does not report support for strict structured outputs "
                "(Models API capabilities.structured_outputs). It is refused: a generation the provider does not hold "
                "to the schema can come back unreadable. Give the agent that does this work a model that reports "
                "supported: true."
            )

        LOG.debug(
            "Generating structured output with inference client",
            extra={"model": self.model_id, "promptLength": len(prompt), "maxTokens": max_tokens, "temperature": temperature},
        )
        # The schema is asked for at the level of the reply, with an array at its root: the
        # reply's text is the JSON. There is no tool, whose input would need a wrapper taken off,
        # and no assistant turn to begin the answer.
        output_config: OutputConfigParam = {"format": {"type": "json_schema", "schema": {"type": "array", "items": dict(element_schema)}}}
        started = time.perf_counter()
        message, request_id = await self._recorded(
            started, prompt, max_tokens, temperature if discovery.temperature_accepted else None, output_config
        )

        counts = _counts(message)
        text = self._answer(started, message, counts)
        stop_reason = message.stop_reason or "unknown"
        try:
            items = read_array(text, stop_reason)
        except StructuredReadError as unread:
            self._record(started, "error", counts)
            LOG.error(
                "Structured response could not be read",
                extra={"model": self.model_id, "textLength": len(text), "stopReason": message.stop_reason, "reason": str(unread)},
            )
            raise

        self._record(started, "success", counts)
        LOG.info(
            "Structured generation completed",
            extra={"model": self.model_id, "items": len(items), "stopReason": message.stop_reason, "requestId": request_id},
        )
        return StructuredResponse(items=items, stop_reason=stop_reason, usage=_usage(counts))

    def _answer(self, started: float, message: Message, counts: _Counts) -> str:
        """The text of the reply's first text block. A reply the provider withheld, and one with no text or an empty one, is a failure.

        A refusal is asked about first: what a refused reply carries is not
        an answer, however much of one it looks like.

        A model that reasons before it answers can spend the whole budget
        first: the reply then holds no text block, or an empty one. Cut off
        before its first character is still cut off, so the stop reason goes
        with the failure, and `max_tokens` is read as a budget too small.
        """
        if message.stop_reason == "refusal":
            self._record(started, "error", counts)
            category = message.stop_details.category if message.stop_details else None
            explanation = message.stop_details.explanation if message.stop_details else None
            LOG.error(
                "The provider withheld its answer", extra={"model": self.model_id, "stopReason": message.stop_reason, "category": category}
            )
            raise ProviderWithheldError(
                f"refusal{f' ({category})' if category else ''}{f': {explanation}' if explanation else ''}", "refusal"
            )
        text = next((block.text for block in message.content if block.type == "text"), None)
        if not text:
            self._record(started, "error", counts)
            LOG.error(
                "Empty response from Anthropic",
                extra={
                    "model": self.model_id,
                    "stopReason": message.stop_reason,
                    "contentTypes": [block.type for block in message.content],
                },
            )
            raise StructuredReadError("response is empty", message.stop_reason or "unknown")
        return text

    def _library(self) -> AsyncAnthropic:
        """The library's client, for one call. It is closed when the call ends, so a driver holds nothing open and has nothing to close.

        Its timeout is left as the library has it (five seconds to connect,
        ten minutes for each of the rest): the library refuses to wait for a
        whole answer only while that is so.
        """
        return AsyncAnthropic(api_key=self._api_key, base_url=self._base_url, max_retries=_MAX_RETRIES)

    async def _discover(self) -> _Discovery:
        async with self._library() as library:
            # The Models API states each model's ceilings and what it can do, so there is no
            # table here to go stale when a model is released.
            try:
                info = await library.models.retrieve(self.model_id)
            except Exception as unlearned:
                raise RuntimeError(f"Failed to discover model limits for '{self.model_id}' from the Models API") from unlearned
            if info.max_input_tokens is None or info.max_tokens is None:
                raise RuntimeError(f"Models API reports no context/output ceilings for '{self.model_id}'")
            # A model the provider says nothing of here is read as one that does not answer in
            # a schema: a structured generation is then refused, and nothing is guessed.
            capabilities = _said(info).get("capabilities")
            structured_outputs = capabilities.get("structured_outputs") if isinstance(capabilities, dict) else None
            structured_outputs_supported = isinstance(structured_outputs, dict) and structured_outputs.get("supported") is True
            temperature_accepted = await self._probe_temperature(library)
        return _Discovery(
            limits=InferenceLimits(
                context_tokens=info.max_input_tokens,
                max_output_tokens=info.max_tokens,
                output_tokens_per_hour=_OUTPUT_TOKENS_PER_HOUR,
                accepts_temperature=temperature_accepted,
            ),
            structured_outputs_supported=structured_outputs_supported,
            temperature_accepted=temperature_accepted,
        )

    async def _probe_temperature(self, library: AsyncAnthropic) -> bool:
        """Whether the model takes a temperature at all, learned by sending it one.

        Some models refuse every temperature, on both kinds of request, and
        the Models API does not say which. One request for one token answers
        it, once for the model. The refusal is matched by its words here,
        where it happens once, so that no generation's failure is read that
        way.
        """
        try:
            await library.messages.create(
                model=self.model_id,
                max_tokens=_TEMPERATURE_PROBE_MAX_TOKENS,
                messages=[{"role": "user", "content": "ok"}],
                extra_body={"temperature": 0.7},
            )
        except Exception as failed:
            if isinstance(failed, APIStatusError) and failed.status_code == 400 and re.search("temperature", failed.message, re.IGNORECASE):
                LOG.warning(
                    "Model rejects `temperature`; caller-supplied values will be omitted from its requests",
                    extra={"model": self.model_id},
                )
                return False
            # Anything else is not an answer. It fails the discovery, which is not kept, so the next call asks again.
            raise RuntimeError(f"Sampling-parameter probe failed for '{self.model_id}'") from failed
        return True

    async def _recorded(
        self, started: float, prompt: str, max_tokens: int, temperature: float | None, output_config: OutputConfigParam | Omit
    ) -> tuple[Message, str | None]:
        """Ask for one generation. A request that fails is counted, and is raised as the interface states a generation's failures."""
        try:
            return await self._request(prompt, max_tokens, temperature, output_config)
        except APIStatusError as refused:
            self._record(started, "error", (None, None))
            if refused.status_code < 400:
                # A failure the provider reported inside a stream it had begun: the library builds
                # it from the response the stream opened with, whose status is 200. No status
                # refused this generation, so it is passed on as it came.
                raise
            raise ProviderStatusError(refused.message, refused.status_code) from refused
        except BaseException:
            # A failure of the library's with no status (a connection that ended), which is passed
            # on as it came, and a caller that cancelled. The library has no failure of its own
            # for a cancelled call and catches no cancellation, so that reaches the caller as it is.
            self._record(started, "error", (None, None))
            raise

    async def _request(
        self, prompt: str, max_tokens: int, temperature: float | None, output_config: OutputConfigParam | Omit
    ) -> tuple[Message, str | None]:
        """The provider's reply to one generation, and the id the provider gave the request.

        The request is made in the caller's own task: cancelling the caller
        ends the attempt under way, and with it the library's waiting to try
        again.
        """
        extra_body = None if temperature is None else {"temperature": temperature}
        async with self._library() as library:
            if max_tokens > _NONSTREAMING_MAX_OUTPUT_TOKENS:
                async with library.messages.stream(
                    model=self.model_id,
                    max_tokens=max_tokens,
                    messages=[{"role": "user", "content": prompt}],
                    output_config=output_config,
                    extra_body=extra_body,
                ) as stream:
                    return await stream.get_final_message(), stream.request_id
            # Asked for with its headers, which is where the provider states the request's id.
            response = await library.messages.with_raw_response.create(
                model=self.model_id,
                max_tokens=max_tokens,
                messages=[{"role": "user", "content": prompt}],
                output_config=output_config,
                extra_body=extra_body,
            )
            return await response.parse(to=Message), response.request_id

    def _record(self, started: float, outcome: Literal["success", "error"], counts: _Counts) -> None:
        input_tokens, output_tokens = counts
        record(
            provider=self.provider,
            model=self.model_id,
            started=started,
            outcome=outcome,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
