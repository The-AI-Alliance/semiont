"""The Together driver: a model Together AI serves, asked through Together's own library, by its Chat Completions API.

The library is not a dependency of this package. It comes with the extra
`semiont-inference[together]`, and this module is the one place it is
imported: whoever does not ask for this driver does not need it.

**What is known of the model, and on whose word.**

- Its context window is the provider's word. Together's API has one read,
  the list of every model it serves, and no request for one model. The list
  is asked for at the first call of `limits`, and the model's entry is found
  in it.
- An entry may state no context length, and Together's own pages show models
  with none. The window is then the one in the facts this driver was handed,
  which is a model catalogue's word and not the provider's, and the driver
  logs a warning that says so. A model the list does not have fails the
  discovery, and nothing is answered in its place: Together moves a model's
  id to its successor on three days' notice.
- The API states no ceiling on what a model writes. That ceiling is the
  catalogue's word, from the same facts, and is never stated above the
  window: a model writes no more than its window holds, and the catalogue's
  numbers are checked neither against the provider's nor against each other.
- Whether the model holds a reply to a schema, whether it takes a
  temperature, and how its reasoning is set are stated nowhere in the API
  either. Whoever makes this driver hands it all of these facts, as a model
  catalogue states them (`semiont_inference.catalogue`). The driver reads no
  file and looks nothing up, and what it says and does by them it says and
  does on the catalogue's word.

**What a request says.** One request of the Chat Completions API, answered
whole: the model, the prompt as the one message of a user, and the most
tokens to write.

- The least thinking, by the kind of option the model's facts name. A model
  whose reasoning is turned on or off is told `reasoning: {enabled: false}`,
  and nothing is less than off. One with no such switch is asked for the
  least of the efforts its facts name. One with neither is sent no setting:
  a budget of tokens has no parameter here, and a model that always reasons
  has nothing it can be told.
- A temperature only where the model's facts say it takes one.
- For an array: the caller's schema as it was written, an array of it at the
  root, as a `response_format` of `json_schema`. `strict` is not said:
  Together publishes nowhere which part of JSON Schema it takes with it. That
  the root may be an array, and a property left out of `required`, is this
  driver's reading. No page of Together's says either.
- Nothing else. No stream, no stop sequence, no tool, no `safety_model`, no
  second choice, and nothing that labels the request. A request over the
  model's window is refused by the provider, which is its default.

**What the provider keeps is not a request's to say.** By default Together
stores the prompts it is sent and the replies it returns, and may use them
to improve its products. No parameter and no header changes that. It is a
setting of the organisation the key belongs to, made by its administrator
(Organization Settings, Privacy: "Store prompts and model responses" set to
No, which is no retention, and with it none of the models Together forwards
to another provider). No request reports the setting, so this driver can
neither ask for it nor check it.

**What a reply is read as.** The JSON the provider wrote, and not the
library's typed model of it, which is built without being checked.

- The answer is the `content` of the one choice, and nothing else. A model's
  thinking comes back beside it, as `reasoning` or as `reasoning_content`,
  whichever the model uses, and is never the answer. It is counted among the
  tokens written, and against the budget a request states.
- `stop` and `eos` are a model that finished: Together tells them apart
  nowhere, and no stop sequence is sent that either could be. `length` is a
  reply the budget ended. Any other word is passed on as the provider's own.
- Together has no signal for an answer withheld: no finish reason for a
  filter, and no refusal beside a message. A model that will not answer says
  so in its text, and stops as one that finished. So this driver raises no
  `ProviderWithheldError`.
- Together states no id of a request, in a header or anywhere else. A
  reply's own `id` is what tells one answer from another in its logs and in
  ours, and a finished generation is logged with it.

**What the library does on its own, and what is done about each**
(`together`, read at 2.40.0, so that a new release of it is read for the
same):

- Its HTTP client takes a proxy and its trusted certificates from the
  environment (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`,
  `SSL_CERT_FILE`, `SSL_CERT_DIR`), and follows redirects. This driver's does
  neither: the address it was given is the address asked.
- It adds headers that describe itself and the machine it runs on
  (`X-Stainless-*`: its version, the operating system, the architecture, the
  Python runtime and its version). It looks for a coding agent it may be
  running under, by some thirty variables of the environment, and names the
  one it finds in `X-Stainless-Agent`; the value of the variable `AI_AGENT`
  goes there as it is. And it adds every line of `TOGETHER_CUSTOM_HEADERS`,
  where an `Authorization` replaces the key the client was given. Every
  header the library would add is left off each request by name, and four
  are stated: `Accept`, `Content-Type`, `User-Agent` (the library's name and
  version) and `Authorization` (the key this driver was given).
- It waits a minute for each read, and sends a request that timed out again,
  twice, with nothing that tells the provider it is the same request. Asked
  for whole, a generation is silent until it is made, so one that takes over
  a minute would be begun three times. This driver states no bound on a
  generation's read (`_TIMEOUT`). The model list keeps the minute
  (`_DISCOVERY_TIMEOUT`).
- It asks again, `max_retries` times, for a request the provider refused
  with 408, 409, 429 or 500 and above, and for one whose connection failed.
  A header `x-should-retry` on the refusal decides it either way, whatever
  the status. It waits as long as a `retry-after` header says, up to a
  minute. Told to wait longer it does not: it asks again after its own
  short wait, as if nothing had been said. `_MAX_RETRIES` states how many
  times.
- It builds a reply into typed models without checking it. The reply is read
  here as the JSON the provider wrote.

**What of it is not switched off**, because the library has no argument for
it:

- `TOGETHER_LOG`, read when the library is imported. It sets the level of
  the library's logger and of the HTTP library's, and configures the root
  logger. At `debug` the library logs every request's options, its body
  among them: the prompt is then written to the log of the process this
  driver runs in, and to nowhere else. Whoever runs a worker keeps that
  variable out of its environment.
- `TOGETHER_PROJECT_ID` is read and kept by every client. It is sent with
  neither request this driver makes.
- A request whose answer is asked for as the provider wrote it carries
  `X-Stainless-Raw-Response: raw`. The library reads that mark back itself.
- It reads what platform it runs on, and looks for a coding agent (in the
  environment, by whether `/opt/.devin` exists, and by whether the process
  has a terminal), for headers that are not sent: the platform in a thread
  at each client's first request, and both once in the process, where they
  are asked, when this driver first asks the library which headers it would
  add.
- `DEFER_PYDANTIC_BUILD`, read when the library is imported, decides when
  the library builds its typed models, and nothing of what is sent.
- `TOGETHER_API_KEY` and `TOGETHER_BASE_URL` are read only by a client given
  no key or no address. This driver gives both.

Its failures: `APIStatusError` carries the status the provider refused with;
`APIConnectionError` carries none. It has no failure of its own for a call
that was cancelled, and catches no cancellation.
"""

import time
from typing import Final, Literal, final

from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont_inference._effort import least_effort
from semiont_inference._log import LOG
from semiont_inference._once import Once, refused_discovery
from semiont_inference._schema import array_schema
from semiont_inference._telemetry import record
from semiont_inference._tokens import Counts, as_usage, count, read_counts
from semiont_inference.catalogue import CatalogueFacts, ToggleOption
from semiont_inference.interface import (
    ElementSchema,
    InferenceLimits,
    InferenceResponse,
    ProviderStatusError,
    StructuredReadError,
    StructuredResponse,
    StructuredUnsupportedError,
)

try:
    from together import APIStatusError, AsyncTogether, DefaultAsyncHttpxClient, Omit, Timeout, omit
    from together.types.chat.completion_create_params import Reasoning, ResponseFormatJsonSchema
except ModuleNotFoundError as missing:
    # A module the library itself lacks is another failure, and is left as it is.
    if missing.name != "together":
        raise
    raise ModuleNotFoundError(
        "The Together driver needs Together's `together` library, which is not installed. "
        "It comes with the extra: install `semiont-inference[together]`.",
        name="together",
    ) from missing

__all__ = ["TogetherInferenceClient"]

_OBJECT: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])
_ARRAY: Final = TypeAdapter[list[JsonValue]](list[JsonValue])

# How long a generation may take. Asked for whole, the provider's answer is one
# HTTP response, and any bound on the wait for it would be a ceiling on a
# generation's length that no caller chose. The library would also answer that
# bound by sending the request again. So there is none, on sending or on the
# answer: a generation ends when it is answered or when its caller cancels it,
# and that is its one bound. Reaching the provider at all is bounded, at ten
# seconds, as it is in the Ollama driver.
_TIMEOUT: Final = Timeout(None, connect=10.0)

# How long the request for the model list may take. The provider answers it
# from what it holds, without running a model: a minute for each of sending,
# the answer and a connection to use, which is the library's own bound today,
# and ten seconds to reach the provider. A list that timed out is asked for
# again like any request that failed, and asking for it again costs nothing.
_DISCOVERY_TIMEOUT: Final = Timeout(60.0, connect=10.0)

# How many times the library asks again for a request that failed. Chosen, and
# not left to the library: two is its default today, and written here a release
# of the library cannot change it unnoticed.
#
# Two rests on what was measured of the Anthropic driver, whose library asks
# again by the same rule: a failure that comes quickly (a 429, a 409, a quick
# 5xx, a connection refused) costs seconds. Together says its serverless models
# answer 429 or 503 when demand is high, and to wait briefly and ask again.
# Nothing has been measured against Together. With no bound on a read, a slow
# generation is never one of the tries.
#
# What would change it: a generation that runs for minutes and then loses its
# connection, again and again. Each try starts it from nothing, and its tries
# together can outlast the worker's bound. If that is seen, lower this number.
_MAX_RETRIES: Final = 2

# The name a request gives the format it asks for, which the API requires. It
# says nothing of what is asked.
_FORMAT_NAME: Final = "elements"

# The headers the library adds to each attempt beside its defaults: which try
# it is, and, for a request with a bound on its read, that bound.
_OF_EACH_ATTEMPT: Final = ("x-stainless-retry-count", "x-stainless-read-timeout")


def _is_turned_off(facts: CatalogueFacts) -> bool:
    """Whether the model's reasoning can be turned off: its facts name a toggle among the ways it is set."""
    return any(isinstance(option, ToggleOption) for option in facts.reasoning_options or ())


def _member(of: JsonValue, name: str) -> JsonValue:
    """The member `name` of `of`, where `of` is an object that has one."""
    return of.get(name) if isinstance(of, dict) else None


def _counts(said: dict[str, JsonValue]) -> Counts:
    """What the provider counted, where a reply states it. The tokens written include any the model spent reasoning."""
    return read_counts(said.get("usage"), "prompt_tokens", "completion_tokens")


def _stop_reason(finish_reason: JsonValue) -> str:
    """Why the model stopped, in the interface's words where it has one. With no reason given it is `unknown`."""
    match finish_reason:
        case "stop" | "eos":
            return "end_turn"
        case "length":
            return "max_tokens"
        case str() if finish_reason:
            return finish_reason
        case _:
            return "unknown"


def _thinking_chars(message: JsonValue) -> int | None:
    """How long the thinking a message carries is, under either name the API has for it, or None where it carries none."""
    carried = (_member(message, name) for name in ("reasoning", "reasoning_content"))
    return sum(len(thinking) for thinking in carried if isinstance(thinking, str)) or None


@final
class TogetherInferenceClient:
    """The model `model` of the Together API at `base_url`, asked with `api_key`. `facts` is what a model catalogue states of it."""

    def __init__(self, *, api_key: str, model: str, base_url: str, facts: CatalogueFacts) -> None:
        self.provider: Final = "together"
        self.model_id: Final = model
        # A hosted API that publishes no limit, in requests, in tokens or in calls in flight: Together says most
        # use meets none, that a model in demand may answer 429 or 503, and to avoid large bursts. Four calls at
        # once is what the Anthropic driver runs at, where it was measured, and is no burst. Nothing has been
        # measured against this provider. A 429 or a 503 is asked again for, twice, by the library.
        self.max_concurrency: Final = 4
        # True of every real provider. No lost yield has been looked for here. The count it is checked
        # against is asked for in a handful of tokens, which a model that cannot be told not to reason
        # may spend before it answers: that count then fails, and the worker says it skipped the check.
        self.verify_detection_yield: Final = True
        self._api_key: Final = api_key
        self._base_url: Final = base_url
        self._holds_to_a_schema: Final = facts.structured_output
        self._takes_temperature: Final = facts.temperature
        self._turned_off: Final = _is_turned_off(facts)
        # Off is less than any effort, and what the provider makes of both said at once is stated nowhere.
        self._effort: Final = None if self._turned_off else least_effort(facts)
        self._catalogue_window: Final = facts.limit.context
        self._catalogue_output: Final = facts.limit.output
        self._limits: Final = Once(self._discover_limits)

    async def limits(self) -> InferenceLimits:
        return await self._limits.get()

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        LOG.debug(
            "Generating text with inference client",
            extra={"model": self.model_id, "promptLength": len(prompt), "maxTokens": max_tokens, "temperature": temperature},
        )
        started = time.perf_counter()
        said = await self._recorded(started, prompt, max_tokens, temperature, omit)

        counts = _counts(said)
        text, stop_reason = self._answer(started, said, counts)
        self._record(started, "success", counts)
        LOG.info(
            "Text generation completed",
            extra={"model": self.model_id, "textLength": len(text), "stopReason": stop_reason, "requestId": said.get("id")},
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
            raise StructuredUnsupportedError(
                f"Model '{self.model_id}' is not known to hold a reply to a JSON Schema: the model catalogue it was given "
                f"{said_of_it} (structured_output). Together's API states this of no model, so the catalogue's word is all there is. "
                "It is refused: a generation the provider does not hold to the schema can come back unreadable. "
                "Give the agent that does this work a model the catalogue says holds a reply to a schema."
            )

        # The schema goes as its caller wrote it, an array of it at the root: the reply's text is the JSON.
        # A keyword this package does not know is refused here, before anything is asked.
        array = array_schema(element_schema, "as-written")
        held_to: ResponseFormatJsonSchema = {
            "type": "json_schema",
            "json_schema": {"name": _FORMAT_NAME, "schema": dict[str, object](array.sent)},
        }

        LOG.debug(
            "Generating structured output with inference client",
            extra={"model": self.model_id, "promptLength": len(prompt), "maxTokens": max_tokens, "temperature": temperature},
        )
        started = time.perf_counter()
        said = await self._recorded(started, prompt, max_tokens, temperature, held_to)

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
            extra={"model": self.model_id, "items": len(items), "stopReason": stop_reason, "requestId": said.get("id")},
        )
        return StructuredResponse(items=items, stop_reason=stop_reason, usage=as_usage(counts))

    def _answer(self, started: float, said: dict[str, JsonValue], counts: Counts) -> tuple[str, str]:
        """The text of the reply's one choice, and why the model stopped.

        One answer was asked for. A reply of more than one choice is a
        failure, and none of them is chosen.

        The text is the choice's `content` alone. A model that reasons
        before it answers can spend the whole budget first, and the reply
        then holds its thinking and no content, or an empty one. Cut off
        before its first character is still cut off, so the stop reason goes
        with the failure, and `max_tokens` is read as a budget too small.
        """
        stated = said.get("choices")
        choices = stated if isinstance(stated, list) else []
        if len(choices) > 1:
            self._record(started, "error", counts)
            LOG.error("More than one choice from Together", extra={"model": self.model_id, "choices": len(choices)})
            raise StructuredReadError(f"the reply holds {len(choices)} choices, not one", "unknown")
        choice = choices[0] if choices else None
        stop_reason = _stop_reason(_member(choice, "finish_reason"))
        message = _member(choice, "message")
        text = _member(message, "content")
        thinking_chars = _thinking_chars(message)

        if self._turned_off and thinking_chars is not None:
            # A driver cannot stop a model that reasons though it was told not to. It can say what that
            # cost: the reasoning was billed, and it is counted among the tokens written.
            LOG.warning(
                "Model produced hidden thinking despite reasoning.enabled:false",
                extra={"model": self.model_id, "thinkingChars": thinking_chars},
            )

        if not isinstance(text, str) or not text:
            self._record(started, "error", counts)
            LOG.error(
                "Empty response from Together", extra={"model": self.model_id, "stopReason": stop_reason, "thinkingChars": thinking_chars}
            )
            raise StructuredReadError("response is empty", stop_reason)
        return text, stop_reason

    def _library(self) -> AsyncTogether:
        """The library's client, for one call. It is closed when the call ends, so a driver holds nothing open and has nothing to close.

        Its HTTP client is stated, and not left to the library: one that
        takes no proxy and no certificates from the environment, and follows
        no redirect.
        """
        return AsyncTogether(
            api_key=self._api_key,
            base_url=self._base_url,
            max_retries=_MAX_RETRIES,
            timeout=_TIMEOUT,
            http_client=DefaultAsyncHttpxClient(trust_env=False, follow_redirects=False),
        )

    def _headers(self, library: AsyncTogether) -> dict[str, str | Omit]:
        """The headers of a request: every one the library would add left off, and the four a request needs stated.

        What the library would add is asked of the library, so that a header
        a later release adds, the agent it found, and whatever the
        environment names, are left off with the rest. The four are stated
        last, where nothing replaces them: a line of the environment's
        cannot stand in for the key.
        """
        left_off: dict[str, str | Omit] = dict.fromkeys((*library.default_headers, *_OF_EACH_ATTEMPT), omit)
        return {
            **left_off,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": library.user_agent,
            "Authorization": f"Bearer {self._api_key}",
        }

    async def _discover_limits(self) -> InferenceLimits:
        learning = f"Failed to discover model limits for '{self.model_id}' from Together's model list"
        async with self._library() as library:
            try:
                response = await library.models.with_raw_response.list(extra_headers=self._headers(library), timeout=_DISCOVERY_TIMEOUT)
                listed = await response.parse(to=str)
            except APIStatusError as refused:
                raise refused_discovery(learning, refused.status_code) from refused
            except Exception as unlearned:
                raise RuntimeError(learning) from unlearned
        try:
            models = _ARRAY.validate_json(listed)
        except ValidationError as not_an_array:
            raise RuntimeError(f"Together's model list is not a JSON array, so it states nothing of '{self.model_id}'") from not_an_array
        entry = next((model for model in models if isinstance(model, dict) and model.get("id") == self.model_id), None)
        if entry is None:
            raise RuntimeError(f"Together's model list does not have '{self.model_id}'")

        stated = count(entry.get("context_length"))
        if stated is not None and stated > 0:
            context_tokens = stated
        else:
            context_tokens = self._catalogue_window
            LOG.warning(
                "Together's model list states no context length for the model: its window is the model catalogue's word",
                extra={"model": self.model_id, "contextTokens": context_tokens},
            )
        # The provider states no ceiling on what a model writes, so that one is the catalogue's. What goes in
        # and what comes out draw on the one window, and the window may be the provider's number where the
        # ceiling is the catalogue's: the ceiling is never stated above the window.
        return InferenceLimits(
            context_tokens=context_tokens,
            max_output_tokens=min(self._catalogue_output, context_tokens),
            output_tokens_per_hour=None,
            accepts_temperature=self._takes_temperature,
        )

    async def _recorded(
        self, started: float, prompt: str, max_tokens: int, temperature: float, held_to: ResponseFormatJsonSchema | Omit
    ) -> dict[str, JsonValue]:
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
        self, prompt: str, max_tokens: int, temperature: float, held_to: ResponseFormatJsonSchema | Omit
    ) -> dict[str, JsonValue]:
        """The provider's reply to one generation, as the JSON it was.

        The request is made in the caller's own task: cancelling the caller
        ends the attempt under way, and with it the library's waiting to try
        again.
        """
        reasoning: Reasoning | Omit = {"enabled": False} if self._turned_off else omit
        # The library's own parameter for an effort names three of them, and the API takes others, by
        # Together's pages and by the catalogue. So an effort goes in `extra_body`, which the library
        # merges into the body it sends.
        effort = None if self._effort is None else {"reasoning_effort": self._effort}
        async with self._library() as library:
            # Asked for as the provider wrote it: the library's typed reply is built without being checked.
            response = await library.chat.completions.with_raw_response.create(
                model=self.model_id,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=max_tokens,
                temperature=temperature if self._takes_temperature is True else omit,
                reasoning=reasoning,
                response_format=held_to,
                extra_headers=self._headers(library),
                extra_body=effort,
            )
            try:
                return _OBJECT.validate_json(await response.parse(to=str))
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
