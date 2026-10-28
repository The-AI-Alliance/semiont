"""The vLLM driver: a model served by vLLM, asked by OpenAI's Chat Completions API through OpenAI's own library.

vLLM is a server its operator runs. This driver asks it through OpenAI's
`openai` library, pointed at the server's address. The library is not a
dependency of this package. It comes with the extra
`semiont-inference[vllm]`, and is imported only when this driver is asked
for.

What this driver shares with the llama.cpp driver is in
`semiont_inference._chat_completions`: what every request says, and how a
reply is read. How the library is set up, what it does on its own and what is
done about each, and what of it could not be switched off are in
`semiont_inference._openai_library`. What is vLLM's own is here. It was read
in vLLM's source at 0.31.0. Nothing here has been seen answered by a vLLM.

**What is known of the model, and on whose word.** Its window is asked of
the server. The rest is true of every model vLLM serves, by vLLM's source.
So this driver is handed no facts about its model.

- Its window is the `max_model_len` of its entry in the server's model list.
  vLLM has no request for one model, so the list is asked. The number is the
  window the engine runs the model with, which an operator's
  `--max-model-len` sets. An adapter's entry states none and names its
  `parent`, whose window is the adapter's. It is one window, which what is
  read and what is written share, so it is given as both ceilings, as the
  Ollama driver gives one.
- What the server does not state is a ceiling its operator put on what a
  model writes (`--override-generation-config`, or a generation config's
  `max_new_tokens`). A request for more is granted less and says nothing: the
  reply stops for `length`.
- It takes a temperature, as every text model vLLM serves does.
- It holds a reply to a schema, as every model vLLM serves does: see below.
  So no model is refused a structured generation.

**What a request says** beside what every request says:

- `reasoning_effort` of `none`: the least thinking. vLLM hands it to the
  model's chat template and turns the template's `enable_thinking` off. A
  template with no such switch, or one of another name (`thinking`, in some),
  is not reached by it, and a model with no switch thinks all the same.
  `thinking_token_budget` is not sent: only a server started with a reasoning
  parser applies it, and whether a budget of zero is no thinking was not
  found.
- `cache_salt`: the most private thing a request can say. vLLM keeps the
  prefixes of prompts it has read, for every caller alike, so one caller can
  tell by timing whether another sent a prefix it guesses. A salt sets a
  caller's prefixes apart. See `_salt` for what it is here.
- The format's `name`, which vLLM refuses a request without.

**A schema is enforced by construction.** vLLM compiles the schema into a
grammar and masks, at each step, every token the grammar does not allow. It
does that for whatever model it serves, and takes an array at the root and a
property left out of `required`. What takes the enforcement away, none of it
reported in a reply:

- A server started with `--reasoning-parser`. The grammar then starts only
  when the model's reasoning has ended, and until then the model writes
  freely. A reply cut off while still reasoning has had no constrained
  character, and arrives here with no content, which is a failure and not an
  empty array. vLLM's `--structured-outputs-config.enable_in_reasoning` is
  its operator's remedy where a model's reasoning is not parsed apart.
- vLLM ignores a member of a request it does not know, and says so only in
  its own log. Its old names for a schema (`guided_json` and the rest,
  removed in 0.12.0) are answered 200 with text held to nothing. So that a
  reply is held rests on this driver sending `response_format` as it does,
  and on a server recent enough to read it.
- A diffusion language model, and a server started with
  `skip_tokenizer_init`, refuse a schema with a 400, which is a status error
  here.

**A request over the window** is the server's to refuse: it counts the
prompt's tokens and answers 400 with the numbers. Nothing is estimated here.

**An answer withheld.** vLLM has no filter and signals none: a reply's
`refusal` is always null, and `content_filter` is not among its reasons for
stopping. What a model declines, it declines in its text. So this driver
never raises `ProviderWithheldError`.

**What a reply says of thinking.** A server with a reasoning parser returns
what a model thought as `reasoning`, beside the content. The answer is read
from the content alone, and a thought that came all the same is warned of.
On a server with no reasoning parser a thought is in the content, tags and
all: plain text then carries it, and nothing here can tell.

**Timeouts, and asking again.** As those two modules state them: no bound on
a generation's read, five minutes for the model list, and two more tries for
what the library asks again for. For vLLM those are a 503 from a queue its
operator bounded, a 500 from a generation that broke, both of which vLLM
means to be asked again, and a server that is not listening yet.

**What only the operator decides.** vLLM reports usage statistics to
`stats.vllm.ai` unless started with `VLLM_NO_USAGE_STATS=1` or
`DO_NOT_TRACK=1` (hardware and settings, no prompts). It logs no request
unless started with `--enable-log-requests`, which logs prompts. Its
`--api-key` guards the paths under `/v1` and a few others, and not every
path it serves.
"""

import base64
import hmac
import secrets
from typing import Final, final

from pydantic import JsonValue

from semiont_inference._once import Once
from semiont_inference._tokens import count
from semiont_inference.interface import ElementSchema, InferenceLimits, InferenceResponse, StructuredResponse

try:
    from semiont_inference._chat_completions import ChatCompletions
except ModuleNotFoundError as missing:
    # A module the library itself lacks is another failure, and is left as it is.
    if missing.name != "openai":
        raise
    raise ModuleNotFoundError(
        "The vLLM driver needs OpenAI's `openai` library, which is not installed. "
        "It comes with the extra: install `semiont-inference[vllm]`.",
        name="openai",
    ) from missing

__all__ = ["VllmInferenceClient"]

# What this process's salts are made from: 256 bits drawn at random when the
# module is first imported, kept nowhere, and sent to nobody.
_SECRET: Final = secrets.token_bytes(32)


def _salt(base_url: str) -> str:
    """What this process salts the prefix cache of the vLLM at `base_url` with.

    vLLM asks for a salt that is random, kept from third parties, and long
    enough not to be guessed: 43 characters of base64, which are 256 bits.
    This is one: the process's secret, keyed to the server's address.

    It is the same for every request this process sends one server,
    whichever of its clients sends it, so the process keeps the whole of its
    own prefix cache there. It differs from one server to the next, so a
    server that was sent one cannot probe another with it. And it is another
    in every process: a worker that starts again starts with a cold cache,
    and two workers do not share one.
    """
    keyed = hmac.digest(_SECRET, base_url.rstrip("/").encode(), "sha256")
    return base64.urlsafe_b64encode(keyed).rstrip(b"=").decode()


def _entry(listed: list[dict[str, JsonValue]], name: JsonValue) -> dict[str, JsonValue] | None:
    """The entry of a model list whose `id` is `name`."""
    return next((entry for entry in listed if isinstance(name, str) and entry.get("id") == name), None)


def _window(entry: dict[str, JsonValue] | None) -> int | None:
    """The window an entry states, or None where it states none."""
    stated = None if entry is None else count(entry.get("max_model_len"))
    return stated if stated is not None and stated > 0 else None


@final
class VllmInferenceClient:
    """The model `model`, served by the vLLM at `base_url`.

    `api_key` is the key the server was started with, or None for a server
    started with none.
    """

    def __init__(self, *, model: str, base_url: str, api_key: str | None) -> None:
        self.provider: Final = "vllm"
        self.model_id: Final = model
        # vLLM batches continuously: calls made at once are decoded together, and each has its own
        # window, so more than one at once is faster and none takes another's room. It states no
        # limit on calls in flight: past what its operator set (`--max-num-seqs`) a call waits in
        # the server's queue, and is refused only where the operator bounded the queue. Four is what
        # the hosted drivers run at, and is far inside any batch a server is started with. Nothing
        # has been measured against a vLLM: how many is best is its hardware's and its operator's.
        self.max_concurrency: Final = 4
        # True of every real provider. No lost yield has been looked for here. The count it is
        # checked against is asked for in a handful of tokens, which a model that thinks though it
        # was asked not to may spend before it answers: that count then fails, and the worker says
        # it skipped the check.
        self.verify_detection_yield: Final = True
        self._server: Final = ChatCompletions(
            provider=self.provider,
            model=model,
            base_url=base_url,
            api_key=api_key,
            own={"reasoning_effort": "none", "cache_salt": _salt(base_url)},
            thinking="reasoning",
        )
        self._limits: Final = Once(self._discover_limits)

    async def limits(self) -> InferenceLimits:
        return await self._limits.get()

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        return await self._server.generate_text(prompt, max_tokens, temperature)

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        return await self._server.generate_structured(prompt, max_tokens, temperature, element_schema)

    async def _discover_limits(self) -> InferenceLimits:
        listed = await self._server.models()
        entry = _entry(listed, self.model_id)
        if entry is None:
            served = ", ".join(name for name in (one.get("id") for one in listed) if isinstance(name, str)) or "no model"
            raise RuntimeError(f"vLLM's model list has no model '{self.model_id}'. It lists: {served}")
        # An adapter's entry states no window, and names the model it was made for, which has one.
        window = _window(entry)
        if window is None:
            window = _window(_entry(listed, entry.get("parent")))
        if window is None:
            raise RuntimeError(f"vLLM's model list reports no max_model_len for '{self.model_id}', nor for a parent it names")
        # One window: what goes in and what comes out draw on the same context, and the server
        # states no separate ceiling on what comes out. So the window is stated as both.
        return InferenceLimits(context_tokens=window, max_output_tokens=window, output_tokens_per_hour=None, accepts_temperature=True)
