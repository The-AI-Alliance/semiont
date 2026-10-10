"""The Google driver: a Gemini model, asked through Google's own library, by the Gemini Developer API's `generateContent`.

The library is not a dependency of this package. It comes with the extra
`semiont-inference[google]`, and this module is the one place it is imported:
whoever does not ask for this driver does not need it.

It asks the Developer API, and neither Vertex AI nor the Interactions API,
which is in beta and keeps every interaction unless told not to.

**What is known of the model, and on whose word.**

- Its limits are the provider's: `models.get` states the most the model
  reads (`inputTokenLimit`) and the most it writes (`outputTokenLimit`), two
  ceilings, asked at the first call of `limits` and kept. A generation does
  not wait for them.
- Whether it holds a reply to a schema, whether it takes a temperature, and
  how its thinking is set, Google's API states of no model. Whoever makes
  this driver hands it those facts, as a model catalogue states them
  (`semiont_inference.catalogue`), and what it says of the model beyond its
  limits it says on the catalogue's word. `models.get` does state a default
  temperature, for models that ignore every temperature they are sent too:
  it is no answer to whether one is taken. Google's pages say its newest
  models ignore a temperature, and that later ones will refuse it. A
  catalogue that says such a model takes one is believed here all the same,
  and the model is sent one: nothing at the provider says otherwise.

**What a request says.** One `generateContent`, answered whole.

- The prompt, as the one turn of a user, and the most to write. Thinking is
  counted against that, and the tokens written are the answer's and the
  thoughts' together.
- The least thinking the model's facts allow, by the kind of option they
  name. A toggle, or a budget of tokens that can be nothing, is thinking
  turned off: `thinkingBudget` 0, which is this API's one way to say so.
  Otherwise a named level is the least of those named, and otherwise a
  budget is the least it states. A level and a budget are never sent
  together: the API refuses the two in one request, and refuses a level to
  a model that takes a budget. A budget whose least the catalogue does not
  state, or writes as -1 (one the model sets itself), is no number to send,
  and a model with no way stated is sent no thinking setting. A least
  effort that Google's API has no level for refuses the client when it is
  made.
- A temperature only where the facts say the model takes one.
- For an array: the element schema as its caller wrote it, with an array at
  the root, as `responseJsonSchema` beside `responseMimeType`
  `application/json`. What Google's API would ignore of it, and so not hold
  a reply to, is refused before any request: the dialect
  `as-written-plain-enums` of `semiont_inference._schema`.
- `store` is false, always: nothing of the request is to be kept. Left
  unsaid, `generateContent` keeps nothing either, unless the key's project
  had logging turned on in AI Studio, and `store` is what overrides that.
  It is a member of the request body in Google's reference, at the top, and
  the library has no field for it: it refuses the name in a request's
  config. So it goes through the library's `extra_body`, which is put into
  the body as it is written and is not checked. A release of the library
  that gains the field is where to move it.
- Nothing else. No safety setting: the adjustable filters are off unless a
  request turns them on. No tool, no cached content, no label, no stop
  sequence, so a model that stops with `STOP` has finished.

What Google does with a prompt beyond that is decided by the key's project,
which no request can set and no reply states. On the free tier, a project
with no billing, content is used to improve Google's products and may be
read by people. On the paid tier it is not, and it is kept fifty-five days
to detect abuse, which nothing of this API turns off.

**What the library does on its own, and what is done about each**
(`google-genai`, read at 2.29.0, so that a new release of it is read for the
same):

- It turns to Vertex AI where `GOOGLE_GENAI_USE_VERTEXAI` or
  `GOOGLE_GENAI_USE_ENTERPRISE` says so and it was not told which API it
  asks, and takes the key it was given there. It is told: not Vertex.
- It takes an address from `GOOGLE_GEMINI_BASE_URL` where it is given none,
  and a key from `GOOGLE_API_KEY` or `GEMINI_API_KEY` where the one it is
  given is empty. This driver gives both, and refuses to be made with either
  empty. The version of the API is stated too (`_API_VERSION`).
- It answers from files, or records to them, where
  `GOOGLE_GENAI_CLIENT_MODE` names a replay mode and it is given no debug
  config. It is given one that names none.
- With `aiohttp` importable it makes its requests through that and not
  through HTTPX: a session that trusts the environment's proxy and reads
  credentials from a `.netrc`, and that sends a request whose connection
  failed a second time, on its own, after up to ten seconds. It keeps to
  HTTPX where it is handed an HTTPX client, and it is handed one.
- Its HTTP clients take a proxy from the environment (`HTTP_PROXY`,
  `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`), follow redirects, and trust the
  certificates `SSL_CERT_FILE` and `SSL_CERT_DIR` name, which the library
  reads itself, for a websocket it never opens here as well. The client it
  is handed does none of that, and it is given the certificates to trust:
  the address this driver was given is the address asked.
- It sends `user-agent` and `x-goog-api-client`, each its name and version
  with the version of the Python it runs on. A request here carries the
  library's name and version as `user-agent`, the key, and what HTTP itself
  needs, and no other header: each request's headers are stated by the HTTP
  client it is handed (`_stating`).
- It bounds no request, and passes each one "no timeout" over whatever the
  HTTP client it is handed states. Its one option for a bound is a single
  number for connecting, sending and the answer alike, which it also sends
  to the provider as a deadline. So the bounds are stated where the headers
  are, on each request (`_GENERATION_TIMEOUT`, `_DISCOVERY_TIMEOUT`).
- It asks once, whatever the answer, unless it is given retry options. It
  is given them (`_ATTEMPTS`, `_ASKED_AGAIN` and the waits beside them).
- It runs every generation through its loop of automatic function calls,
  and logs that it does. That is turned off: no function is offered.
- It builds a reply into typed models, takes the first of several
  candidates, and warns of a finish reason it does not know. A generation's
  reply is asked for as the HTTP response it was, and read here as the JSON
  the provider wrote.

**What of it is not switched off**, because the library has no argument for
it:

- A provider that says how long to wait before asking again is not heard:
  the library reads no `retry-after` and nothing of a refusal's body, and
  its waits are its own arithmetic.
- `GOOGLE_API_KEY` and `GEMINI_API_KEY` are read by every client, and with
  both set it logs a warning that names the two variables, at every call
  here, since a client is made for each. The key it was given is the one
  sent. `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` are read and
  kept, and used only by a client of Vertex.
- Every client makes a second HTTP client, for calls that block, which this
  driver never makes. It is told to trust nothing of the environment, and is
  closed with the call.
- It logs at INFO each time it waits to ask again, with what the provider
  said in refusing, and HTTPX logs each request's address, which names the
  model. Neither holds the key or a prompt.
- When one of its clients is collected it starts a task on the running loop
  to close itself, which finds nothing left to close.
- It tries to import `aiohttp` and `httpx2` when it is imported, and uses
  whichever HTTP client it is handed.

Its failures: `errors.APIError` carries the status the provider refused
with, as `code`. A connection that failed is HTTPX's failure, as it was
raised. It has no failure of its own for a call that was cancelled, and
catches no cancellation.
"""

import time
from collections.abc import AsyncGenerator, Callable, Coroutine
from contextlib import asynccontextmanager
from typing import Final, Literal, Protocol, assert_never, final

import httpx
from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont_inference._effort import least_effort
from semiont_inference._log import LOG
from semiont_inference._once import Once
from semiont_inference._schema import array_schema
from semiont_inference._telemetry import record
from semiont_inference._tokens import Counts, as_usage, count
from semiont_inference.catalogue import BudgetTokensOption, CatalogueFacts, ReasoningEffort, ToggleOption
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
    from google.genai import Client, errors, types, version
    from google.genai.client import DebugConfig
except ModuleNotFoundError as missing:
    # A module the library itself lacks is another failure, and is left as it is.
    if missing.name not in ("google", "google.genai"):
        raise
    raise ModuleNotFoundError(
        "The Google driver needs Google's `google-genai` library, which is not installed. "
        "It comes with the extra: install `semiont-inference[google]`.",
        name="google.genai",
    ) from missing

__all__ = ["GoogleInferenceClient"]

_OBJECT: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])

# The version of the API that is asked. What a request says here (`responseJsonSchema`, `thinkingConfig`) is this
# version's, so it is stated, and not left to what a release of the library takes as its default.
_API_VERSION: Final = "v1beta"

# How long a generation may take. Asked for whole, the provider's answer is one
# HTTP response, and any bound on the wait for it would be a ceiling on a
# generation's length that no caller chose, which the library would also answer
# by sending the request again. So there is none, on sending or on the answer: a
# generation ends when it is answered or when its caller cancels it, and that is
# its one bound. Reaching the provider at all is bounded, at ten seconds, as it
# is in the Ollama driver.
_GENERATION_TIMEOUT: Final = httpx.Timeout(None, connect=10.0)

# How long the request for a model's limits may take: ten seconds to connect,
# and a minute for each of the rest. The provider answers it from what it holds
# of the model, without running it. Nothing has been measured: a minute is long
# for such an answer, and short enough that three tries end in about three.
_DISCOVERY_TIMEOUT: Final = httpx.Timeout(60.0, connect=10.0)

# How many times a request is made in all. The library asks once unless it is
# told otherwise, so this is this driver's choice, and three is what the
# Anthropic and OpenAI drivers come to: the first, and two more.
#
# It rests on what was measured of the Anthropic driver: a failure that comes
# quickly (a 429, a quick 5xx, a connection refused) costs seconds. Nothing has
# been measured against Google. With no bound on the wait for an answer, a slow
# generation is never one of the tries, and a connection that ends unanswered is
# not asked for again: the library asks again for a refusal and for a
# connection that was never made, and for nothing else.
#
# What would change it: a generation that runs for minutes and is then refused
# (a 504, the provider's own deadline), again and again. Each try starts it from
# nothing, and its tries together can outlast the worker's bound. If that is
# seen, lower this number, or take 504 out of `_ASKED_AGAIN`.
_ATTEMPTS: Final = 3

# The refusals that are asked for again: the library's own list, written here so
# that a release of the library cannot change it unnoticed. Of them Google's
# pages name 429 and 503 as worth asking again for. A 429 that says a day's
# quota or a spending cap is used up is asked for twice more all the same:
# nothing in the status tells it from a minute's rate.
_ASKED_AGAIN: Final = (408, 429, 500, 502, 503, 504)

# How long the library waits before it asks again, in seconds: `_FIRST_WAIT`
# before the second try, `_WAIT_GROWTH` times as long before each one after,
# never above `_LONGEST_WAIT`, and each time up to `_WAIT_SPREAD` more, at
# random. They are the library's own numbers, stated for the same reason.
_FIRST_WAIT: Final = 1.0
_WAIT_GROWTH: Final = 2.0
_LONGEST_WAIT: Final = 60.0
_WAIT_SPREAD: Final = 1.0

# The reasons a candidate stops for that say the provider withheld its answer,
# or ended one it had begun. The first six the library lists (`FinishReason`);
# the last two are in Google's reference and not in the library, which keeps a
# word it does not know as it came. Any other reason is not known to be an
# answer withheld, and is not called one: called withheld, a job is never tried
# again. A release of the library that lists a new reason fails
# tests/test_google.py, where each is read.
_WITHHELD: Final = frozenset(
    {"SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "ESCALATION", "PUP_LIMITED_DISABLED"}
)

# The headers a request carries, and no other: what HTTP itself needs, the key, and who is asking.
_HEADERS: Final = frozenset(
    {"host", "accept", "accept-encoding", "connection", "content-length", "content-type", "user-agent", "x-goog-api-key"}
)

# Who is asking: the library's name and version, as the library begins its own `user-agent`, and nothing of the machine it runs on.
_USER_AGENT: Final = f"google-genai-sdk/{version.__version__}"


def _stating(bounds: httpx.Timeout) -> Callable[[httpx.Request], Coroutine[None, None, None]]:
    """What the HTTP client the library is handed does to each request before it is sent: it states the request's bounds and its headers.

    The library passes every request "no timeout", over whatever its HTTP
    client states, and adds headers that say what Python it runs on. Here is
    where a request is last seen before it is sent, so here both are stated.
    """

    async def state(request: httpx.Request) -> None:
        request.extensions["timeout"] = bounds.as_dict()
        for name in [*request.headers]:
            if name not in _HEADERS:
                del request.headers[name]
        request.headers["user-agent"] = _USER_AGENT

    return state


def _level(effort: ReasoningEffort) -> types.ThinkingLevel | None:
    """The thinking level Google's API has for an effort a catalogue names, or None where it has none."""
    match effort:
        case "minimal":
            return types.ThinkingLevel.MINIMAL
        case "low":
            return types.ThinkingLevel.LOW
        case "medium":
            return types.ThinkingLevel.MEDIUM
        case "high":
            return types.ThinkingLevel.HIGH
        case "none" | "xhigh" | "max":
            return None
        case _:
            assert_never(effort)


def _least_thinking(model: str, facts: CatalogueFacts) -> types.ThinkingConfig | None:
    """The least thinking the model's facts allow, as the one thinking setting a request carries, or None where they state no way to set it.

    Turned off, where the facts say it can be: a toggle, or a budget that
    can be nothing. Otherwise the least level they name. Otherwise the least
    budget they state. A budget whose least is not stated, or is below
    nothing (the catalogue writes -1 for one the model sets itself), states
    no number to send.

    Raises `ValueError` where the least effort named is one Google's API has
    no level for: no other level is sent in its place.
    """
    options = facts.reasoning_options or ()
    budgets = [option.min for option in options if isinstance(option, BudgetTokensOption) and option.min is not None and option.min >= 0]
    if any(isinstance(option, ToggleOption) for option in options) or 0 in budgets:
        return types.ThinkingConfig(thinking_budget=0)
    least = least_effort(facts)
    if least is not None:
        level = _level(least)
        if level is None:
            raise ValueError(
                f"The model catalogue names `{least}` as the least reasoning effort of '{model}', and Google's API has no thinking "
                "level of that name: its levels are minimal, low, medium and high. No other level is sent in its place."
            )
        return types.ThinkingConfig(thinking_level=level)
    if budgets:
        return types.ThinkingConfig(thinking_budget=min(budgets))
    return None


def _counted(said: dict[str, JsonValue], name: str) -> int | None:
    """One count of a reply's `usageMetadata`, where the reply states it."""
    usage = said.get("usageMetadata")
    return count(usage.get(name)) if isinstance(usage, dict) else None


def _counts(said: dict[str, JsonValue]) -> Counts:
    """What the provider counted, where a reply states it.

    Google counts the tokens of the answer and the tokens the model spent
    thinking apart, and bills both as written: what was written is the two
    together. Its API leaves out a count that is nothing, so one of the two
    stated alone is the whole of what was written: a model that did not
    think, or one cut off before it answered. With neither stated, what was
    written is not known.
    """
    answer, thoughts = _counted(said, "candidatesTokenCount"), _counted(said, "thoughtsTokenCount")
    written = None if answer is None and thoughts is None else (answer or 0) + (thoughts or 0)
    return _counted(said, "promptTokenCount"), written


def _stop_reason(finish_reason: JsonValue) -> str:
    """Why the model stopped, in the interface's words where it has one.

    `STOP` is the model's own stop, since no stop sequence is sent. Any
    other reason is the provider's own word for it, and with none stated it
    is `unknown`.
    """
    match finish_reason:
        case "STOP":
            return "end_turn"
        case "MAX_TOKENS":
            return "max_tokens"
        case str() if finish_reason:
            return finish_reason
        case _:
            return "unknown"


def _candidates(said: dict[str, JsonValue]) -> list[dict[str, JsonValue]]:
    """The candidates of a reply. A reply to a prompt the provider blocked has none."""
    candidates = said.get("candidates")
    return [candidate for candidate in candidates if isinstance(candidate, dict)] if isinstance(candidates, list) else []


def _text(candidate: dict[str, JsonValue]) -> str:
    """The text of a candidate's answer: its text parts put together, without those that hold what the model thought.

    Empty where it has none.
    """
    content = candidate.get("content")
    parts = content.get("parts") if isinstance(content, dict) else None
    texts: list[str] = []
    for part in parts if isinstance(parts, list) else ():
        if isinstance(part, dict) and part.get("thought") is not True:
            text = part.get("text")
            if isinstance(text, str):
                texts.append(text)
    return "".join(texts)


class _Generating(Protocol):
    """What this driver asks of the library's models: one generation, by a prompt that is text.

    The library's own `generate_content` takes a prompt of many kinds, among
    them an image of a library that is not installed here. A type checker
    reads that kind as unknown, and with it the whole method. Stated as
    this, what is asked for is known, and each checker holds the library's
    method to it.
    """

    async def generate_content(
        self, *, model: str, contents: str, config: types.GenerateContentConfig
    ) -> types.GenerateContentResponse: ...


async def _generated(models: _Generating, model: str, prompt: str, config: types.GenerateContentConfig) -> types.GenerateContentResponse:
    """One generation, asked of the library's models as this driver states them."""
    return await models.generate_content(model=model, contents=prompt, config=config)


@final
class GoogleInferenceClient:
    """The model `model` of the Gemini Developer API at `base_url`, asked with `api_key`. `facts` is what a model catalogue states of it.

    `base_url` is the API's root, as Google's library takes it: the version
    of the API is added to it here.
    """

    def __init__(self, *, api_key: str, model: str, base_url: str, facts: CatalogueFacts) -> None:
        if not api_key.strip():
            raise ValueError(
                "api_key is required for the Google inference client: given an empty one, Google's library takes a key from "
                "the environment (GOOGLE_API_KEY, GEMINI_API_KEY)"
            )
        if not base_url.strip():
            raise ValueError(
                "base_url is required for the Google inference client: given an empty one, Google's library takes an address "
                "from the environment (GOOGLE_GEMINI_BASE_URL)"
            )
        self.provider: Final = "google"
        self.model_id: Final = model
        # A hosted API whose limits are rates of a project: requests a minute, tokens read a minute, requests a day. Google
        # publishes none of the numbers and says nothing of calls in flight. Four is what the Anthropic driver runs at, where
        # it was measured. Nothing has been measured against this provider. What could bind here is the requests a minute of
        # a project on the free tier, or of a preview model, which Google says are held lower.
        self.max_concurrency: Final = 4
        # True of every real provider. No lost yield has been looked for here. The count it is checked against is asked for
        # in a handful of tokens, and thinking is counted against what is asked for: a model whose thinking cannot be turned
        # off may spend them before it answers. That count then fails, and the worker says it skipped the check.
        self.verify_detection_yield: Final = True
        self._api_key: Final = api_key
        self._base_url: Final = base_url
        self._holds_to_a_schema: Final = facts.structured_output
        self._takes_temperature: Final = facts.temperature
        self._thinking: Final = _least_thinking(model, facts)
        self._limits: Final = Once(self._discover_limits)

    async def limits(self) -> InferenceLimits:
        return await self._limits.get()

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        LOG.debug(
            "Generating text with inference client",
            extra={"model": self.model_id, "promptLength": len(prompt), "maxTokens": max_tokens, "temperature": temperature},
        )
        started = time.perf_counter()
        said = await self._recorded(started, prompt, max_tokens, temperature, None)

        counts = _counts(said)
        text, stop_reason = self._answer(started, said, counts)
        self._record(started, "success", counts)
        LOG.info(
            "Text generation completed",
            extra={"model": self.model_id, "textLength": len(text), "stopReason": stop_reason, "requestId": said.get("responseId")},
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
                f"{said_of_it} (structured_output). Google's API states this of no model, so the catalogue's word is all there is. "
                "It is refused: a generation the provider does not hold to the schema can come back unreadable. "
                "Give the agent that does this work a model the catalogue says holds a reply to a schema."
            )

        # Google's API takes JSON Schema with an array at its root and a property left out of `required`, so
        # the schema goes as its caller wrote it, and an element is read as the model wrote it. It ignores a
        # `const`, and an `enum` of more than text and numbers, and says nothing: the dialect refuses those.
        array = array_schema(element_schema, "as-written-plain-enums")

        LOG.debug(
            "Generating structured output with inference client",
            extra={"model": self.model_id, "promptLength": len(prompt), "maxTokens": max_tokens, "temperature": temperature},
        )
        started = time.perf_counter()
        said = await self._recorded(started, prompt, max_tokens, temperature, array.sent)

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
            extra={"model": self.model_id, "items": len(items), "stopReason": stop_reason, "requestId": said.get("responseId")},
        )
        return StructuredResponse(items=items, stop_reason=stop_reason, usage=as_usage(counts))

    def _answer(self, started: float, said: dict[str, JsonValue], counts: Counts) -> tuple[str, str]:
        """The text of the reply's answer, and why the model stopped.

        An answer withheld is asked about first, in each of its two shapes.
        Neither is a refusal by status: both come back as any reply does. A
        prompt the provider blocked has a reason in what the reply says of
        the prompt, and no candidate. A candidate the provider stopped has
        one of the reasons of `_WITHHELD`. What such a reply carries is not
        an answer, however much of one it looks like.

        Then the text. Thinking is counted against the output asked for, so
        a model can spend the whole budget before it answers, and the reply
        then holds no content, or content with no text. Cut off before its
        first character is still cut off, so the stop reason goes with the
        failure, and `max_tokens` is read as a budget too small. One
        candidate is asked for: more than one is a failure too, and none of
        them is chosen.
        """
        feedback = said.get("promptFeedback")
        block = feedback.get("blockReason") if isinstance(feedback, dict) else None
        if isinstance(block, str) and block:
            raise self._withheld(started, counts, block, f"the prompt was blocked: {block}", "prompt")

        candidates = _candidates(said)
        candidate = candidates[0] if candidates else {}
        finish_reason = candidate.get("finishReason")
        if isinstance(finish_reason, str) and finish_reason in _WITHHELD:
            explanation = candidate.get("finishMessage")
            why = f": {explanation}" if isinstance(explanation, str) and explanation else ""
            raise self._withheld(started, counts, finish_reason, f"{finish_reason}{why}", "answer")

        stop_reason = _stop_reason(finish_reason)
        if len(candidates) > 1:
            self._record(started, "error", counts)
            LOG.error(
                "More than one candidate from Google",
                extra={"model": self.model_id, "stopReason": stop_reason, "candidates": len(candidates)},
            )
            raise StructuredReadError(f"the reply holds {len(candidates)} candidates, not one", stop_reason)
        text = _text(candidate)
        if not text:
            self._record(started, "error", counts)
            LOG.error(
                "Empty response from Google",
                extra={"model": self.model_id, "stopReason": stop_reason, "thoughtsTokens": _counted(said, "thoughtsTokenCount")},
            )
            raise StructuredReadError("response is empty", stop_reason)
        return text, stop_reason

    def _withheld(
        self, started: float, counts: Counts, reason: str, detail: str, blocked: Literal["prompt", "answer"]
    ) -> ProviderWithheldError:
        """The failure of a reply the provider withheld, for the provider's own word `reason`. It is counted and logged here."""
        self._record(started, "error", counts)
        LOG.error("The provider withheld its answer", extra={"model": self.model_id, "reason": reason, "blocked": blocked})
        return ProviderWithheldError(detail, reason)

    @asynccontextmanager
    async def _library(self, bounds: httpx.Timeout) -> AsyncGenerator[Client, None]:
        """The library's client, for one call, each request of which is bounded by `bounds`.

        It is closed when the call ends, so a driver holds nothing open and
        has nothing to close.

        Everything the library would otherwise take from the environment is
        stated: which API it asks, its key, its address, that it replays
        nothing, and the certificates to trust. Its HTTP client is stated
        too, and not left to the library: one that takes no proxy from the
        environment and follows no redirect, and that states each request's
        bounds and headers.
        """
        certificates = httpx.create_ssl_context(trust_env=False)
        async with httpx.AsyncClient(
            verify=certificates, trust_env=False, follow_redirects=False, event_hooks={"request": [_stating(bounds)]}
        ) as http:
            library = Client(
                vertexai=False,
                api_key=self._api_key,
                debug_config=DebugConfig(client_mode=None, replays_directory=None, replay_id=None),
                http_options=types.HttpOptions(
                    base_url=self._base_url,
                    api_version=_API_VERSION,
                    httpx_async_client=http,
                    # For the client of blocking calls the library makes beside it, and for the websocket it never opens.
                    client_args={"verify": certificates, "trust_env": False},
                    async_client_args={"ssl": certificates},
                    retry_options=types.HttpRetryOptions(
                        attempts=_ATTEMPTS,
                        http_status_codes=[*_ASKED_AGAIN],
                        initial_delay=_FIRST_WAIT,
                        exp_base=_WAIT_GROWTH,
                        max_delay=_LONGEST_WAIT,
                        jitter=_WAIT_SPREAD,
                    ),
                ),
            )
            try:
                yield library
            finally:
                library.close()

    async def _discover_limits(self) -> InferenceLimits:
        try:
            async with self._library(_DISCOVERY_TIMEOUT) as library:
                model = await library.aio.models.get(model=self.model_id)
        except Exception as unlearned:
            raise RuntimeError(f"Failed to discover model limits for '{self.model_id}' from Google's models.get") from unlearned
        if model.input_token_limit is None or model.output_token_limit is None:
            raise RuntimeError(f"Google's models.get states no input and output token limits for '{self.model_id}'")
        # Two ceilings: the most the model reads, and the most it writes, which is taken from nothing else.
        return InferenceLimits(
            context_tokens=model.input_token_limit,
            max_output_tokens=model.output_token_limit,
            output_tokens_per_hour=None,
            accepts_temperature=self._takes_temperature,
        )

    async def _recorded(
        self, started: float, prompt: str, max_tokens: int, temperature: float, held_to: dict[str, JsonValue] | None
    ) -> dict[str, JsonValue]:
        """Ask for one generation. A request that fails is counted, and is raised as the interface states a generation's failures."""
        try:
            return await self._request(prompt, max_tokens, temperature, held_to)
        except errors.APIError as refused:
            self._record(started, "error", (None, None))
            raise ProviderStatusError(str(refused), refused.code) from refused
        except BaseException:
            # An answer that could not be read at all, a failure of the HTTP library's with no status (a
            # connection that ended), which is passed on as it came, and a caller that cancelled. The
            # library has no failure of its own for a cancelled call and catches no cancellation, so
            # that reaches the caller as it is.
            self._record(started, "error", (None, None))
            raise

    async def _request(
        self, prompt: str, max_tokens: int, temperature: float, held_to: dict[str, JsonValue] | None
    ) -> dict[str, JsonValue]:
        """The provider's reply to one generation, as the JSON it was.

        The request is made in the caller's own task: cancelling the caller
        ends the attempt under way, and with it the library's waiting to try
        again.
        """
        config = types.GenerateContentConfig(
            max_output_tokens=max_tokens,
            temperature=temperature if self._takes_temperature is True else None,
            thinking_config=self._thinking,
            response_mime_type=None if held_to is None else "application/json",
            response_json_schema=held_to,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            # The reply as the HTTP response it was, and not as the library's models of it.
            should_return_http_response=True,
            # Nothing is to be kept. The library has no field for `store`: this is put into the request's body as it is written.
            http_options=types.HttpOptions(extra_body={"store": False}),
        )
        async with self._library(_GENERATION_TIMEOUT) as library:
            response = await _generated(library.aio.models, self.model_id, prompt, config)
        answered = response.sdk_http_response
        if answered is None or answered.body is None:
            raise RuntimeError("Google's library answered a generation without the HTTP response it was asked to return")
        try:
            return _OBJECT.validate_json(answered.body)
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
