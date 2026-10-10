"""The Ollama driver: a model served by Ollama, asked over Ollama's own HTTP API."""

import math
import time
from typing import Final, Literal, final

import httpx
from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont_inference._log import LOG
from semiont_inference._once import Once
from semiont_inference._structured import read_array
from semiont_inference._telemetry import record
from semiont_inference._tokens import as_usage, count, read_counts
from semiont_inference.interface import (
    ElementSchema,
    InferenceLimits,
    InferenceResponse,
    ProviderStatusError,
    StructuredReadError,
    StructuredResponse,
)

__all__ = ["OllamaInferenceClient"]

_OBJECT: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])

# How long the request for a model's limits may take. Ollama answers `/api/show`
# from what it holds of the model, without running it. These are the bounds the
# TypeScript driver's request has from its platform: ten seconds to connect, and
# five minutes for each of the rest (sending, the answer, a connection to use).
_DISCOVERY_TIMEOUT: Final = httpx.Timeout(300.0, connect=10.0)

# How long a generation may take. With `stream: false` Ollama sends nothing, not
# a header, until the whole answer is made. Any bound on the wait for it would be
# a ceiling on a generation's length that no caller chose, reported as a failure
# of the network. So there is none, on sending or on the answer: a generation
# ends when its caller cancels it, and that is its one bound. Reaching the server
# at all is bounded, at ten seconds.
_GENERATION_TIMEOUT: Final = httpx.Timeout(None, connect=10.0)

# Added to the estimate of the prompt when `num_ctx` is sized: a share of the
# estimate, since its error grows with the prompt, and a fixed allowance for the
# model's chat template. A window too small clips what was sent and says nothing,
# which is the loss a stated `num_ctx` is there to prevent, and one too large
# only costs memory. So the slack leans generous, and the result is never above
# the model's real window.
_NUM_CTX_ESTIMATE_SLACK: Final = 0.2
_NUM_CTX_TEMPLATE_ALLOWANCE: Final = 64

# The rule of `estimateTokens` in TypeScript's core (packages/core/src/chunking.ts),
# which cuts a text into pieces by it too: about four code points to a token,
# rounded up. Python has no chunking yet. When it has, the two must have one home.
_CODE_POINTS_PER_TOKEN: Final = 4


def _estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / _CODE_POINTS_PER_TOKEN)


def _context_length(body: bytes) -> int | None:
    """The context length an answer of `/api/show` states, or None where it states none.

    It is the member of `model_info` named `<architecture>.context_length`,
    where `general.architecture` names the architecture. A model whose
    metadata names no architecture has it under some `*.context_length`.
    """
    try:
        model_info = _OBJECT.validate_json(body).get("model_info")
    except ValidationError:
        return None
    if not isinstance(model_info, dict):
        return None
    architecture = model_info.get("general.architecture")
    if isinstance(architecture, str):
        direct = count(model_info.get(f"{architecture}.context_length"))
        if direct is not None and direct > 0:
            return direct
    for name, value in model_info.items():
        if name.endswith(".context_length"):
            stated = count(value)
            return stated if stated is not None and stated > 0 else None
    return None


def _stop_reason(done_reason: JsonValue) -> str:
    """Why the model stopped, in the interface's words. With no reason given it is `unknown`."""
    match done_reason:
        case "stop":
            return "end_turn"
        case "length":
            return "max_tokens"
        case str() if done_reason:
            return done_reason
        case _:
            return "unknown"


@final
class OllamaInferenceClient:
    """The model `model`, served by the Ollama at `base_url`."""

    def __init__(self, *, model: str, base_url: str) -> None:
        self.provider: Final = "ollama"
        self.model_id: Final = model
        # One local model: how fast it generates is its hardware's, so calls made at once queue,
        # or split one GPU, and are no faster together. Each also holds memory for its context.
        self.max_concurrency: Final = 1
        # A detection that quietly loses its yield has been measured on this provider.
        self.verify_detection_yield: Final = True
        self._base_url: Final = base_url.rstrip("/")
        self._limits: Final = Once(self._discover_limits)

    async def limits(self) -> InferenceLimits:
        return await self._limits.get()

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        return await self._generate(prompt, max_tokens, temperature, None)

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        # The schema goes to Ollama's `format`, which holds the generation itself to it, the
        # types of an element included. The text that comes back is then read here.
        response = await self._generate(prompt, max_tokens, temperature, element_schema)
        try:
            items = read_array(response.text, response.stop_reason)
        except StructuredReadError as unread:
            LOG.error(
                "Structured response could not be read",
                extra={"model": self.model_id, "textLength": len(response.text), "stopReason": response.stop_reason, "reason": str(unread)},
            )
            raise
        return StructuredResponse(items=items, stop_reason=response.stop_reason, usage=response.usage)

    async def _discover_limits(self) -> InferenceLimits:
        # The address a config names is the address asked: no proxy of the environment stands between.
        async with httpx.AsyncClient(timeout=_DISCOVERY_TIMEOUT, trust_env=False) as http:
            response = await http.post(f"{self._base_url}/api/show", json={"model": self.model_id})
        if not response.is_success:
            raise RuntimeError(f"Failed to discover model limits: /api/show returned {response.status_code} for '{self.model_id}'")
        context_tokens = _context_length(response.content)
        if context_tokens is None:
            raise RuntimeError(f"/api/show reports no context length for '{self.model_id}'")
        # One window: what goes in and what comes out draw on the same context, and there is no
        # separate ceiling on what comes out. So the window is stated as both. Ollama takes a
        # temperature for every model it serves.
        return InferenceLimits(
            context_tokens=context_tokens, max_output_tokens=context_tokens, output_tokens_per_hour=None, accepts_temperature=True
        )

    async def _generate(self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema | None) -> InferenceResponse:
        LOG.debug(
            "Generating text with Ollama",
            extra={
                "model": self.model_id,
                "promptLength": len(prompt),
                "maxTokens": max_tokens,
                "temperature": temperature,
                "structured": element_schema is not None,
            },
        )

        # The window is stated with every request, sized to cover it and never above the model's
        # own. With no `num_ctx` Ollama takes the model's default window and clips any prompt
        # beyond it: what was sent is lost, and nothing says so.
        limits = await self.limits()
        prompt_tokens = _estimate_tokens(prompt)
        if prompt_tokens + max_tokens > limits.context_tokens:
            raise ValueError(
                f"Prompt (~{prompt_tokens} tokens) + output budget ({max_tokens}) exceed the "
                f"'{self.model_id}' context window ({limits.context_tokens} tokens)"
            )
        num_ctx = min(
            limits.context_tokens,
            prompt_tokens + max_tokens + math.ceil(prompt_tokens * _NUM_CTX_ESTIMATE_SLACK) + _NUM_CTX_TEMPLATE_ALLOWANCE,
        )

        body: dict[str, JsonValue] = {
            "model": self.model_id,
            "prompt": prompt,
            "stream": False,
            # A model that reasons before it answers is told not to. One served from Ollama's
            # cloud does so all the same, which is warned of below.
            "think": False,
            "options": {"num_predict": max_tokens, "num_ctx": num_ctx, "temperature": temperature},
        }
        if element_schema is not None:
            # `format` takes the word `json` (any JSON at all) or a schema. What is asked for is
            # an array of elements, so the schema is an array's: under the bare word a model may
            # answer `{"entities": [...]}`, which nothing that reads an array can use. A model
            # served locally is held to the schema. One served from Ollama's cloud takes it as
            # advice, and what it gets wrong is a `StructuredReadError`.
            body["format"] = {"type": "array", "items": dict(element_schema)}

        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=_GENERATION_TIMEOUT, trust_env=False) as http:
                response = await http.post(f"{self._base_url}/api/generate", json=body)
        except BaseException:
            # However the request ended, a generation was asked for and did not end well: a
            # failure of the network, and a caller that cancelled, which closes the connection
            # so that nothing goes on being generated for it.
            self._record(started, "error", None, None)
            raise

        if not response.is_success:
            self._record(started, "error", None, None)
            LOG.error("Ollama API error", extra={"model": self.model_id, "status": response.status_code, "body": response.text})
            raise ProviderStatusError(f"Ollama API error ({response.status_code}): {response.text}", response.status_code)

        try:
            said = _OBJECT.validate_json(response.content)
        except ValidationError as not_an_object:
            self._record(started, "error", None, None)
            raise StructuredReadError("the provider's answer is not a JSON object", "unknown") from not_an_object

        stop_reason = _stop_reason(said.get("done_reason"))
        text, thinking = said.get("response"), said.get("thinking")
        # What the provider counted. The tokens written include any the model spent reasoning out of sight.
        counts = read_counts(said, "prompt_eval_count", "eval_count")
        thinking_chars = len(thinking) if isinstance(thinking, str) and thinking else None

        if thinking_chars is not None:
            # A driver cannot stop a model that ignores `think: false`. It can say what that cost:
            # the reasoning was billed, and it is counted among the tokens written.
            LOG.warning(
                "Model produced hidden thinking despite think:false", extra={"model": self.model_id, "thinkingChars": thinking_chars}
            )

        if not isinstance(text, str) or not text:
            self._record(started, "error", *counts)
            LOG.error(
                "Empty response from Ollama", extra={"model": self.model_id, "stopReason": stop_reason, "thinkingChars": thinking_chars}
            )
            # Cut off before its first character is still cut off: the stop reason goes with the
            # failure, so that `max_tokens` is read as a budget too small and not as a mystery.
            raise StructuredReadError("response is empty", stop_reason)

        self._record(started, "success", *counts)
        LOG.info("Text generation completed", extra={"model": self.model_id, "textLength": len(text), "stopReason": stop_reason})
        return InferenceResponse(text=text, stop_reason=stop_reason, usage=as_usage(counts))

    def _record(self, started: float, outcome: Literal["success", "error"], input_tokens: int | None, output_tokens: int | None) -> None:
        record(
            provider=self.provider,
            model=self.model_id,
            started=started,
            outcome=outcome,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
