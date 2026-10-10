"""OpenAI's Chat Completions API, as a server that is not OpenAI's speaks it, asked through OpenAI's own library.

What the vLLM driver (`semiont_inference.vllm`) and the llama.cpp driver
(`semiont_inference.llamacpp`) do alike is here: one generation and the
reading of its reply, and the request for a server's model list, each asked
through the library. What is one server's own is in its driver, which hands
this client two things: the members of a request that are the server's own
(what it is told of thinking and of its cache), and the name it returns a
model's thinking under. Nothing that only one of the servers does is decided
here.

The library is not a dependency of this package. It comes with the extra of
either driver. A driver imports this module, and names its own extra where
the library is not installed.

How the library is set up, what it does on its own and what is done about
each, and what of it is not switched off are in
`semiont_inference._openai_library`, which this module shares with the OpenAI
driver. What of that is this module's own:

- A server started with no key is given none: the library is opened with no
  key, and no `Authorization` is sent.
- A generation is asked for as the server wrote it, so it carries the
  library's mark of that. The library's own reading builds its typed models
  from whatever came, and a model list into pages. The request for a model
  list is asked for as text, and carries no mark.
- A generation has no bound on a read. The request for a model list has one
  (`_LIST_TIMEOUT`).

**What a request says.** One request of the Chat Completions API, answered
whole: the model, the prompt as one user message, `max_completion_tokens`,
the temperature, and the server's own members. Nothing that keeps or labels
a request is sent: no `store`, `metadata`, `user`, `prompt_cache_key` or
`safety_identifier`, and no tool. For an array, `response_format` asks for a
`json_schema`: an array at the root, whose elements are the caller's schema
as the caller wrote it (`semiont_inference._schema`, which refuses a keyword
it does not know), under the name the API requires. `strict` is not sent: it
is what turns on OpenAI's own strict mode, and these servers do not read it.
"""

import time
from collections.abc import Mapping
from typing import Final, Literal, final

from openai import APIStatusError, Omit, Timeout, omit
from openai.types.shared_params import ResponseFormatJSONSchema
from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont_inference._log import LOG
from semiont_inference._once import refused_discovery
from semiont_inference._openai_library import open_library, request_headers
from semiont_inference._schema import array_schema
from semiont_inference._telemetry import record
from semiont_inference._tokens import Counts, as_usage, read_counts
from semiont_inference.interface import (
    ElementSchema,
    InferenceResponse,
    ProviderStatusError,
    StructuredReadError,
    StructuredResponse,
)

_OBJECT: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])

# How long the request for a model list may take. A server answers it from what
# it holds, without running a model. The bounds are those of the Ollama driver's
# request for a model's limits: ten seconds to connect, and five minutes for each
# of the rest. The library asks again for a request that timed out, so a server
# that takes this one and never answers is given up after three times that.
_LIST_TIMEOUT: Final = Timeout(300.0, connect=10.0)

# The name a request gives the format it asks for, which the API requires. It
# says nothing of what is asked.
_FORMAT_NAME: Final = "elements"


def _counts(said: dict[str, JsonValue]) -> Counts:
    """What the server counted, where a reply states it. The tokens written include any the model spent thinking."""
    return read_counts(said.get("usage"), "prompt_tokens", "completion_tokens")


def _stop_reason(finish_reason: JsonValue) -> str:
    """Why the model stopped, in the interface's words where it has one. With no reason given it is `unknown`.

    `stop` is the model's own end, or a stop sequence, which no request made
    here states. Any other word is passed on as the server's.
    """
    match finish_reason:
        case "stop":
            return "end_turn"
        case "length":
            return "max_tokens"
        case str() if finish_reason:
            return finish_reason
        case _:
            return "unknown"


@final
class ChatCompletions:
    """The model `model` of the server at `base_url`, which speaks the Chat Completions API.

    `provider` is the name its generations are counted under. `api_key` is
    the key the server was started with, or None for a server started with
    none. `own` is what every generation's request says beside what is said
    here, in the server's own members. `thinking` names the member of a
    reply's message under which the server returns what a model thought.
    """

    def __init__(
        self, *, provider: str, model: str, base_url: str, api_key: str | None, own: Mapping[str, JsonValue], thinking: str
    ) -> None:
        if api_key is not None and not api_key.strip():
            raise ValueError(
                "api_key is empty. It is the key the server was started with, or None for a server started with none: "
                "an empty key is neither, and is not taken for one of them."
            )
        self._provider: Final = provider
        self._model: Final = model
        self._base_url: Final = base_url
        self._api_key: Final = api_key
        self._own: Final = dict(own)
        self._thinking: Final = thinking

    async def models(self) -> list[dict[str, JsonValue]]:
        """The entries of the server's model list, each as the JSON the server wrote.

        What a driver learns from them is its model's limits, so a list that
        cannot be had is a discovery that failed: a `ProviderStatusError`
        where the server refused with a status, and a plain error where
        there was none.
        """
        learning = f"Failed to discover model limits for '{self._model}' from the server's model list"
        try:
            async with open_library(api_key=self._api_key, base_url=self._base_url) as library:
                headers = request_headers(library, api_key=self._api_key, with_a_body=False)
                listed = await library.get("/models", cast_to=str, options={"headers": headers, "timeout": _LIST_TIMEOUT})
        except APIStatusError as refused:
            raise refused_discovery(learning, refused.status_code) from refused
        except Exception as unlearned:
            raise RuntimeError(learning) from unlearned
        try:
            entries = _OBJECT.validate_json(listed).get("data")
        except ValidationError:
            entries = None
        if not isinstance(entries, list):
            raise RuntimeError(f"Failed to discover model limits for '{self._model}': the server's answer is not a model list")
        return [entry for entry in entries if isinstance(entry, dict)]

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        LOG.debug(
            "Generating text with inference client",
            extra={"model": self._model, "promptLength": len(prompt), "maxTokens": max_tokens, "temperature": temperature},
        )
        started = time.perf_counter()
        said = await self._recorded(started, prompt, max_tokens, temperature, omit)

        counts = _counts(said)
        text, stop_reason = self._answer(started, said, counts)
        self._record(started, "success", counts)
        LOG.info(
            "Text generation completed",
            extra={"model": self._model, "textLength": len(text), "stopReason": stop_reason, "requestId": said.get("id")},
        )
        return InferenceResponse(text=text, stop_reason=stop_reason, usage=as_usage(counts))

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        # An array at the root and a property left optional go as the caller wrote them.
        array = array_schema(element_schema, "as-written")
        held_to: ResponseFormatJSONSchema = {
            "type": "json_schema",
            "json_schema": {"name": _FORMAT_NAME, "schema": dict[str, object](array.sent)},
        }

        LOG.debug(
            "Generating structured output with inference client",
            extra={"model": self._model, "promptLength": len(prompt), "maxTokens": max_tokens, "temperature": temperature},
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
                extra={"model": self._model, "textLength": len(text), "stopReason": stop_reason, "reason": str(unread)},
            )
            raise

        self._record(started, "success", counts)
        LOG.info(
            "Structured generation completed",
            extra={"model": self._model, "items": len(items), "stopReason": stop_reason, "requestId": said.get("id")},
        )
        return StructuredResponse(items=items, stop_reason=stop_reason, usage=as_usage(counts))

    def _answer(self, started: float, said: dict[str, JsonValue], counts: Counts) -> tuple[str, str]:
        """The content of the reply's one choice, and why the model stopped.

        One answer is asked for. A reply of more than one choice is a
        failure: none of them is chosen.

        The answer is the content alone. What a model thought is returned
        beside it, under the server's own name, and is not part of it. A
        model that thinks before it answers can spend the whole budget first,
        and the content is then null or empty. Cut off before its first
        character is still cut off, so the stop reason goes with the failure,
        and `max_tokens` is read as a budget too small.
        """
        stated = said.get("choices")
        choices = [choice for choice in stated if isinstance(choice, dict)] if isinstance(stated, list) else []
        if len(choices) > 1:
            self._record(started, "error", counts)
            LOG.error("More than one choice from the server", extra={"model": self._model, "choices": len(choices)})
            raise StructuredReadError(f"the reply holds {len(choices)} choices, not one", "unknown")
        choice: dict[str, JsonValue] = choices[0] if choices else {}
        stop_reason = _stop_reason(choice.get("finish_reason"))
        message = choice.get("message")
        content, thought = (message.get("content"), message.get(self._thinking)) if isinstance(message, dict) else (None, None)
        thinking_chars = len(thought) if isinstance(thought, str) and thought else None

        if thinking_chars is not None:
            # A driver cannot stop a model that thinks though it was asked not to. It can say what that
            # cost: the thought was generated, and it is counted among the tokens written.
            LOG.warning(
                "Model produced hidden thinking though it was asked for none", extra={"model": self._model, "thinkingChars": thinking_chars}
            )

        if not isinstance(content, str) or not content:
            self._record(started, "error", counts)
            LOG.error(
                "Empty response from the server", extra={"model": self._model, "stopReason": stop_reason, "thinkingChars": thinking_chars}
            )
            raise StructuredReadError("response is empty", stop_reason)
        return content, stop_reason

    async def _recorded(
        self, started: float, prompt: str, max_tokens: int, temperature: float, held_to: ResponseFormatJSONSchema | Omit
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
        self, prompt: str, max_tokens: int, temperature: float, held_to: ResponseFormatJSONSchema | Omit
    ) -> dict[str, JsonValue]:
        """The server's reply to one generation, as the JSON it was.

        The request is made in the caller's own task: cancelling the caller
        ends the attempt under way, and with it the library's waiting to try
        again.
        """
        async with open_library(api_key=self._api_key, base_url=self._base_url) as library:
            # Asked for raw: the library's own reading builds its typed models from whatever came.
            response = await library.chat.completions.with_raw_response.create(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                max_completion_tokens=max_tokens,
                temperature=temperature,
                response_format=held_to,
                extra_body=self._own,
                extra_headers=request_headers(library, api_key=self._api_key, with_a_body=True),
            )
            try:
                return _OBJECT.validate_json(response.parse(to=str))
            except ValidationError as not_an_object:
                raise StructuredReadError("the provider's answer is not a JSON object", "unknown") from not_an_object

    def _record(self, started: float, outcome: Literal["success", "error"], counts: Counts) -> None:
        input_tokens, output_tokens = counts
        record(
            provider=self._provider,
            model=self._model,
            started=started,
            outcome=outcome,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
