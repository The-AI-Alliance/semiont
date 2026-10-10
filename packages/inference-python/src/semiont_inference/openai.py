"""The OpenAI driver: a model of OpenAI's, asked through OpenAI's own library, by its Responses API.

The library is not a dependency of this package. It comes with the extra
`semiont-inference[openai]`, and this module is the one place it is imported:
whoever does not ask for this driver does not need it.

**What is known of the model.** OpenAI's API states nothing of a model: not
its limits, not whether it holds a reply to a schema, not which reasoning
efforts it takes, not whether it takes a temperature. So this driver asks the
provider nothing about its model and looks nothing up. Whoever makes it hands
it the model's facts, as a model catalogue states them
(`semiont_inference.catalogue`), and what it says of the model it says on the
catalogue's word.

**What a request says.** One request of the Responses API, answered whole.

- `store` is false, always. Left unsaid, the provider keeps a response for
  thirty days. Nothing else that keeps or labels a request is sent: no
  background mode, no conversation or earlier response to go on from, no
  `metadata`, `user`, `prompt_cache_key` or `safety_identifier`.
- How long the provider caches a prompt is left as the provider has it. The
  API has two settings for it, and neither is known to be taken by every
  model: OpenAI says some models refuse the most private value of
  `prompt_cache_retention`, and documents `prompt_cache_options` for its
  newest models alone. A setting a model refuses fails every request.
- The least reasoning the model's facts name, and a temperature only where
  the model is known to take one beside that.
- For an array: the element schema rewritten for OpenAI's strict mode
  (`semiont_inference._schema`), which takes an object at the root with every
  property required, and `strict` stated.

**What the library does on its own, and what is done about each** (`openai`,
read at 3.28.0, so that a new release of it is read for the same):

- Its HTTP client takes a proxy and its trusted certificates from the
  environment (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`,
  `SSL_CERT_FILE`, `SSL_CERT_DIR`), and follows redirects. This driver's does
  neither: the address it was given is the address asked.
- It adds headers that describe itself and the machine it runs on
  (`X-Stainless-*`: its version, the operating system, the architecture, the
  Python runtime and its version), an `OpenAI-Organization` and an
  `OpenAI-Project` read from `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID`, and
  every line of `OPENAI_CUSTOM_HEADERS`. An `Authorization` among those lines
  replaces the key the client was given. Every header the library would add
  is left off each request by name, and four are stated: `Accept`,
  `Content-Type`, `User-Agent` (the library's name and version) and
  `Authorization` (the key this driver was given).
- It waits ten minutes for each read, and sends a request that timed out
  again, twice, with nothing that tells the provider it is the same request.
  This driver states no bound on a read (`_TIMEOUT`), so no generation is
  started a second time for being slow.
- It asks again, `max_retries` times, for a request the provider refused with
  408, 409, 429 or 500 and above, and for one whose connection failed. It
  waits as long as a `retry-after` header says, up to two minutes, and does
  not ask again at all where the header says longer. `_MAX_RETRIES` states
  how many times.
- It builds a reply into typed models without checking it, and its
  `output_text` joins the text of every message of a reply. The reply is read
  here as the JSON the provider wrote.

**What of it is not switched off**, because the library has no argument for
it:

- `OPENAI_LOG`, read when the library is imported: it sets the level of the
  library's logger and configures the root logger. What the library logs is a
  request's method, status, retry count and id, and no address, header or
  body.
- `OPENAI_ADMIN_KEY` and `OPENAI_WEBHOOK_SECRET` are read and kept by every
  client. Neither is sent to the Responses API.
- A request whose answer is asked for with its headers, which is where the
  provider states the request's id, carries `X-Stainless-Raw-Response: true`.
  The library reads that mark back itself.
- It reads what platform it runs on, for headers that are not sent: in a
  thread at each client's first request, and once in the process, where it is
  asked, when this driver first asks it which headers it would add.
- `OPENAI_API_KEY` and `OPENAI_BASE_URL` are read only by a client given no
  key or no address. This driver gives both.

Its failures: `APIStatusError` carries the status the provider refused with;
`APIConnectionError` carries none. It has no failure of its own for a call
that was cancelled, and catches no cancellation.
"""

import time
from typing import Final, Literal, final

from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont_inference._log import LOG
from semiont_inference._schema import array_schema
from semiont_inference._telemetry import record
from semiont_inference._tokens import Counts, as_usage, read_counts
from semiont_inference.catalogue import CatalogueFacts, EffortOption, ReasoningEffort
from semiont_inference.interface import (
    ElementSchema,
    InferenceLimits,
    InferenceResponse,
    ProviderStatusError,
    ProviderWithheldError,
    StructuredReadError,
    StructuredResponse,
)

try:
    from openai import APIStatusError, AsyncOpenAI, DefaultAsyncHttpx2Client, Omit, Timeout, omit
    from openai.types.responses import ResponseTextConfigParam
    from openai.types.shared_params import Reasoning
except ModuleNotFoundError as missing:
    # A module the library itself lacks is another failure, and is left as it is.
    if missing.name != "openai":
        raise
    raise ModuleNotFoundError(
        "The OpenAI driver needs OpenAI's `openai` library, which is not installed. "
        "It comes with the extra: install `semiont-inference[openai]`.",
        name="openai",
    ) from missing

__all__ = ["OpenAIInferenceClient"]

_OBJECT: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])

# How long a generation may take. Asked for whole, the provider's answer is one
# HTTP response, and any bound on the wait for it would be a ceiling on a
# generation's length that no caller chose. The library would also answer that
# bound by sending the request again. So there is none, on sending or on the
# answer: a generation ends when it is answered or when its caller cancels it,
# and that is its one bound. Reaching the provider at all is bounded, at ten
# seconds, as it is in the Ollama driver.
_TIMEOUT: Final = Timeout(None, connect=10.0)

# How many times the library asks again for a request that failed. Chosen, and
# not left to the library: two is its default today, and written here a release
# of the library cannot change it unnoticed.
#
# Two rests on what was measured of the Anthropic driver, whose library asks
# again by the same rule: a failure that comes quickly (a 429, a 409, a quick
# 5xx, a connection refused) costs seconds, and the library waits as long as
# `retry-after` says. Nothing has been measured against OpenAI. With no bound
# on a read, a slow generation is never one of the tries.
#
# What would change it: a generation that runs for minutes and then loses its
# connection, again and again. Each try starts it from nothing, and its tries
# together can outlast the worker's bound. If that is seen, lower this number.
_MAX_RETRIES: Final = 2

# The name a request gives the format it asks for, which the API requires. The
# provider treats a schema and its name as data about the account, not as
# content, so the name says nothing of what is asked.
_FORMAT_NAME: Final = "elements"

# The codes of a failed reply that say the provider blocked the request, of
# those the library lists (`ResponseError.code`). Any other code is a generation
# that broke (`server_error`, `rate_limit_exceeded`), which is not an answer
# withheld: called withheld, a job is never tried again. A release of the
# library that lists a new code fails tests/test_openai.py, where each is read.
_BLOCKED: Final = frozenset({"invalid_prompt", "bio_policy", "misalignment_policy_violation", "image_content_policy_violation"})

# The header the library adds to each attempt beside its defaults.
_RETRY_COUNT: Final = "x-stainless-retry-count"


def _rank(effort: ReasoningEffort) -> int:
    """Where an effort stands, from the least reasoning to the most."""
    match effort:
        case "none":
            return 0
        case "minimal":
            return 1
        case "low":
            return 2
        case "medium":
            return 3
        case "high":
            return 4
        case "xhigh":
            return 5
        case "max":
            return 6


def _least_effort(facts: CatalogueFacts) -> ReasoningEffort | None:
    """The least reasoning effort the model's facts name, or None where they name none.

    OpenAI's API takes reasoning by a named effort and by nothing else. A way
    of another kind (a toggle, a budget of tokens) has no parameter there, so
    a model whose facts state only such ways, or no way at all, is sent no
    reasoning setting. A catalogue does not always list efforts from least to
    most.
    """
    named: list[ReasoningEffort] = [
        effort for option in facts.reasoning_options or () if isinstance(option, EffortOption) for effort in option.values
    ]
    return min(named, key=_rank, default=None)


def _takes_temperature(facts: CatalogueFacts, effort: ReasoningEffort | None) -> bool | None:
    """Whether a caller's temperature is sent: True where it is, False where the model refuses one, None where its facts do not say.

    The facts say whether the model takes a temperature at all. OpenAI
    refuses one beside any reasoning effort but `none`, so a model that is
    asked for more than that is one that refuses it, as this driver asks it.
    """
    if facts.temperature is not True:
        return facts.temperature
    return effort is None or effort == "none"


def _counts(said: dict[str, JsonValue]) -> Counts:
    """What the provider counted, where a reply states it. The tokens written include any the model spent reasoning out of sight."""
    return read_counts(said.get("usage"), "input_tokens", "output_tokens")


def _stop_reason(status: JsonValue, incomplete: JsonValue) -> str:
    """Why the model stopped, in the interface's words where it has one.

    The Responses API states no stop reason: a reply has a status, and a
    reason where it is incomplete. A reply the budget ended is `max_tokens`.
    Any other is the provider's own word for it, and with no status stated it
    is `unknown`. There is no stop sequence: the API takes none.
    """
    match status:
        case "completed":
            return "end_turn"
        case "incomplete":
            if incomplete == "max_output_tokens":
                return "max_tokens"
            return incomplete if isinstance(incomplete, str) and incomplete else "incomplete"
        case str() if status:
            return status
        case _:
            return "unknown"


def _output(said: dict[str, JsonValue]) -> list[dict[str, JsonValue]]:
    """The items of a reply's output: its messages, and whatever else the model put there."""
    output = said.get("output")
    return [item for item in output if isinstance(item, dict)] if isinstance(output, list) else []


def _final_parts(said: dict[str, JsonValue]) -> list[dict[str, JsonValue]]:
    """The parts of a reply's final answer.

    A reply can hold more than one message: a model may say something on the
    way to its answer, which is a message whose `phase` is `commentary`. The
    answer is in the messages whose phase is `final_answer`, or is not
    stated.
    """
    parts: list[dict[str, JsonValue]] = []
    for item in _output(said):
        content = item.get("content")
        if item.get("type") == "message" and item.get("phase") in (None, "final_answer") and isinstance(content, list):
            parts += [part for part in content if isinstance(part, dict)]
    return parts


@final
class OpenAIInferenceClient:
    """The model `model` of the OpenAI API at `base_url`, asked with `api_key`. `facts` is what a model catalogue states of it."""

    def __init__(self, *, api_key: str, model: str, base_url: str, facts: CatalogueFacts) -> None:
        self.provider: Final = "openai"
        self.model_id: Final = model
        # A hosted API whose limits are rates, a minute's requests and tokens, with none stated on calls
        # in flight: at its lowest paid tier OpenAI states 5,000 requests a minute for its current models,
        # which four calls at once are far inside. Four is what the Anthropic driver runs at, where it was
        # measured. Nothing has been measured against this provider. What could bind here is the token
        # rate, which OpenAI reckons from the output a call asks for and not from what it writes.
        self.max_concurrency: Final = 4
        # True of every real provider. No lost yield has been looked for here. The count it is checked
        # against is asked for in a handful of tokens, which a model that cannot be told not to reason
        # may spend before it answers: that count then fails, and the worker says it skipped the check.
        self.verify_detection_yield: Final = True
        self._api_key: Final = api_key
        self._base_url: Final = base_url
        self._holds_to_a_schema: Final = facts.structured_output
        self._effort: Final = _least_effort(facts)
        self._takes_temperature: Final = _takes_temperature(facts, self._effort)
        # The catalogue's `context` is the whole window, which what is read and what is written share,
        # and its `output` a ceiling of its own on what is written: a caller takes what it asks to be
        # written from the window. Where the catalogue also states the most a model reads, that has no
        # place in the interface's limits, and is not said here.
        self._limits: Final = InferenceLimits(
            context_tokens=facts.limit.context,
            max_output_tokens=facts.limit.output,
            output_tokens_per_hour=None,
            accepts_temperature=self._takes_temperature,
        )

    async def limits(self) -> InferenceLimits:
        return self._limits

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        LOG.debug(
            "Generating text with inference client",
            extra={"model": self.model_id, "promptLength": len(prompt), "maxTokens": max_tokens, "temperature": temperature},
        )
        started = time.perf_counter()
        said, request_id = await self._recorded(started, prompt, max_tokens, temperature, omit)

        counts = _counts(said)
        text, stop_reason = self._answer(started, said, counts)
        self._record(started, "success", counts)
        LOG.info(
            "Text generation completed",
            extra={"model": self.model_id, "textLength": len(text), "stopReason": stop_reason, "requestId": request_id},
        )
        return InferenceResponse(text=text, stop_reason=stop_reason, usage=as_usage(counts))

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        # Which model is asked is a matter of config, and one not known to hold a reply to a schema is
        # refused. A generation held to nothing can come back unreadable, and an unreadable reply taken
        # for an empty one completes a job that found nothing.
        if self._holds_to_a_schema is not True:
            said_of_it = "says it does not" if self._holds_to_a_schema is False else "does not say that it does"
            raise RuntimeError(
                f"Model '{self.model_id}' is not known to hold a reply to a JSON Schema: the model catalogue it was given "
                f"{said_of_it} (structured_output). OpenAI's API states this of no model, so the catalogue's word is all there is. "
                "It is refused: a generation the provider does not hold to the schema can come back unreadable. "
                "Give the agent that does this work a model the catalogue says holds a reply to a schema."
            )

        # OpenAI's strict mode takes an object at the root, with every property of every object
        # required. So the array is asked for as the one property of an object, and a property the
        # caller left optional as one that takes null. `array.read` undoes both.
        array = array_schema(element_schema, "object-root-all-required")
        held_to: ResponseTextConfigParam = {
            "format": {"type": "json_schema", "name": _FORMAT_NAME, "strict": True, "schema": dict[str, object](array.sent)}
        }

        LOG.debug(
            "Generating structured output with inference client",
            extra={"model": self.model_id, "promptLength": len(prompt), "maxTokens": max_tokens, "temperature": temperature},
        )
        started = time.perf_counter()
        said, request_id = await self._recorded(started, prompt, max_tokens, temperature, held_to)

        counts = _counts(said)
        text, stop_reason = self._answer(started, said, counts)
        try:
            items = array.read(text, stop_reason)
        except StructuredReadError as unread:
            self._record(started, "error", counts)
            LOG.error(
                "Structured response could not be read",
                extra={"model": self.model_id, "textLength": len(text), "stopReason": stop_reason, "reason": str(unread)},
            )
            raise

        self._record(started, "success", counts)
        LOG.info(
            "Structured generation completed",
            extra={"model": self.model_id, "items": len(items), "stopReason": stop_reason, "requestId": request_id},
        )
        return StructuredResponse(items=items, stop_reason=stop_reason, usage=as_usage(counts))

    def _answer(self, started: float, said: dict[str, JsonValue], counts: Counts) -> tuple[str, str]:
        """The text of the reply's final answer, and why the model stopped.

        An answer withheld is asked about first, in each of its three shapes:
        a reply that failed because the provider blocked the request, a reply
        a filter ended, and a reply that is complete and holds a refusal
        where its text would be. What such a reply carries is not an answer,
        however much of one it looks like.

        Then the text. A model that reasons before it answers can spend the
        whole budget first, and the reply then holds no message, or an empty
        one. Cut off before its first character is still cut off, so the stop
        reason goes with the failure, and `max_tokens` is read as a budget
        too small. More than one final text is a failure too: none of them is
        chosen.
        """
        status = said.get("status")
        if status == "failed":
            raise self._failed(started, counts, said.get("error"))
        details = said.get("incomplete_details")
        incomplete = details.get("reason") if isinstance(details, dict) else None
        if status == "incomplete" and incomplete == "content_filter":
            raise self._withheld(started, counts, status, "content_filter", "content_filter")
        parts = _final_parts(said)
        refusals = [part.get("refusal") for part in parts if part.get("type") == "refusal"]
        if refusals:
            explanation = refusals[0]
            raise self._withheld(
                started, counts, status, "refusal", f"refusal: {explanation}" if isinstance(explanation, str) and explanation else "refusal"
            )

        stop_reason = _stop_reason(status, incomplete)
        texts = [part.get("text") for part in parts if part.get("type") == "output_text"]
        if len(texts) > 1:
            self._record(started, "error", counts)
            LOG.error(
                "More than one final text from OpenAI", extra={"model": self.model_id, "stopReason": stop_reason, "texts": len(texts)}
            )
            raise StructuredReadError(f"the reply holds {len(texts)} final texts, not one", stop_reason)
        text = texts[0] if texts else None
        if not isinstance(text, str) or not text:
            self._record(started, "error", counts)
            LOG.error(
                "Empty response from OpenAI",
                extra={"model": self.model_id, "stopReason": stop_reason, "outputTypes": [item.get("type") for item in _output(said)]},
            )
            raise StructuredReadError("response is empty", stop_reason)
        return text, stop_reason

    def _withheld(self, started: float, counts: Counts, status: JsonValue, reason: str, detail: str) -> ProviderWithheldError:
        """The failure of a reply the provider withheld, for the provider's own word `reason`. It is counted and logged here."""
        self._record(started, "error", counts)
        LOG.error("The provider withheld its answer", extra={"model": self.model_id, "status": status, "reason": reason})
        return ProviderWithheldError(detail, reason)

    def _failed(self, started: float, counts: Counts, error: JsonValue) -> ProviderWithheldError | RuntimeError:
        """The failure of a reply whose status is `failed`, by the code it states.

        A code that says the provider blocked the request is an answer
        withheld. Any other, and a code no release of the library lists, is a
        generation that broke: a plain failure with no status, which a caller
        may ask for again.
        """
        code = error.get("code") if isinstance(error, dict) else None
        explanation = error.get("message") if isinstance(error, dict) else None
        why = f": {explanation}" if isinstance(explanation, str) and explanation else ""
        if isinstance(code, str) and code in _BLOCKED:
            return self._withheld(started, counts, "failed", code, f"{code}{why}")
        self._record(started, "error", counts)
        LOG.error("OpenAI reported that the generation failed", extra={"model": self.model_id, "code": code})
        if not isinstance(code, str) or not code:
            return RuntimeError("OpenAI reported that the generation failed, and stated no code")
        return RuntimeError(f"OpenAI reported that the generation failed: {code}{why}")

    def _library(self) -> AsyncOpenAI:
        """The library's client, for one call. It is closed when the call ends, so a driver holds nothing open and has nothing to close.

        Its HTTP client is stated, and not left to the library: one that
        takes no proxy and no certificates from the environment, and follows
        no redirect.
        """
        return AsyncOpenAI(
            api_key=self._api_key,
            base_url=self._base_url,
            max_retries=_MAX_RETRIES,
            timeout=_TIMEOUT,
            http_client=DefaultAsyncHttpx2Client(trust_env=False, follow_redirects=False),
        )

    def _headers(self, library: AsyncOpenAI) -> dict[str, str | Omit]:
        """The headers of a request: every one the library would add left off, and the four a request needs stated.

        What the library would add is asked of the library, so that a header
        a later release adds, and whatever the environment names, is left off
        with the rest. The four are stated last, where nothing replaces them:
        a line of the environment's cannot stand in for the key.
        """
        left_off: dict[str, str | Omit] = dict.fromkeys((*library.default_headers, _RETRY_COUNT), omit)
        return {
            **left_off,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": library.user_agent,
            "Authorization": f"Bearer {self._api_key}",
        }

    async def _recorded(
        self, started: float, prompt: str, max_tokens: int, temperature: float, held_to: ResponseTextConfigParam | Omit
    ) -> tuple[dict[str, JsonValue], str | None]:
        """Ask for one generation. A request that fails is counted, and is raised as the interface states a generation's failures."""
        try:
            return await self._request(prompt, max_tokens, temperature, held_to)
        except APIStatusError as refused:
            self._record(started, "error", (None, None))
            raise ProviderStatusError(refused.message, refused.status_code) from refused
        except BaseException:
            # An answer that could not be read at all, a failure of the library's with no status (a
            # connection that ended), which is passed on as it came, and a caller that cancelled. The
            # library has no failure of its own for a cancelled call and catches no cancellation, so
            # that reaches the caller as it is.
            self._record(started, "error", (None, None))
            raise

    async def _request(
        self, prompt: str, max_tokens: int, temperature: float, held_to: ResponseTextConfigParam | Omit
    ) -> tuple[dict[str, JsonValue], str | None]:
        """The provider's reply to one generation, as the JSON it was, and the id the provider gave the request.

        The request is made in the caller's own task: cancelling the caller
        ends the attempt under way, and with it the library's waiting to try
        again.
        """
        reasoning: Reasoning | Omit = omit if self._effort is None else {"effort": self._effort}
        async with self._library() as library:
            # Asked for with its headers, which is where the provider states the request's id.
            response = await library.responses.with_raw_response.create(
                model=self.model_id,
                input=prompt,
                max_output_tokens=max_tokens,
                store=False,
                reasoning=reasoning,
                temperature=temperature if self._takes_temperature else omit,
                text=held_to,
                extra_headers=self._headers(library),
            )
            try:
                return _OBJECT.validate_json(response.parse(to=str)), response.request_id
            except ValidationError as not_an_object:
                raise StructuredReadError("the provider's answer is not a JSON object", "unknown") from not_an_object

    def _record(self, started: float, outcome: Literal["success", "error"], counts: Counts) -> None:
        input_tokens, output_tokens = counts
        record(
            provider=self.provider,
            model=self.model_id,
            started=started,
            outcome=outcome,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
