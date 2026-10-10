"""The llama.cpp driver: a model served by llama.cpp's server, asked by OpenAI's Chat Completions API through OpenAI's own library.

`llama-server` is a server its operator runs. This driver asks it through
OpenAI's `openai` library, pointed at the server's address. The library is
not a dependency of this package. It comes with the extra
`semiont-inference[llamacpp]`, and is imported only when this driver is asked
for.

What this driver shares with the vLLM driver is in
`semiont_inference._chat_completions`: what every request says, and how a
reply is read. How the library is set up, what it does on its own and what is
done about each, and what of it could not be switched off are in
`semiont_inference._openai_library`. What is llama.cpp's own is here. It was
read in llama.cpp's source at 0.6.0. Nothing here has been seen answered by a
llama.cpp server.

**What is known of the model, and on whose word.** Its window is asked of
the server. The rest is true of every model the server loads, by llama.cpp's
source. So this driver is handed no facts about its model.

- Its window is the `meta.n_ctx` of its entry in the server's model list,
  which is the window of one of the server's slots. A model is served under
  one name or several, and its entry is the one that has the name this driver
  was given, as its `id` or among its `aliases`. It is one window, which what
  is read and what is written share, so it is given as both ceilings, as the
  Ollama driver gives one. An entry has no `meta` while its model loads, and,
  where one server routes between models, until its model is loaded: the
  limits are then not learned, and the next call asks again. Nothing this
  driver asks loads a model such a server has not loaded.
- It takes a temperature, as every model the server loads does.
- It holds a reply to a schema, as every model the server loads does: see
  below. So no model is refused a structured generation.

**What a request says** beside what every request says:

- `reasoning_effort` of `none` and `reasoning_budget_tokens` of zero: the
  least thinking. The first tells the model's chat template not to think. A
  template with no such switch thinks all the same, and the second ends a
  thought as it opens, where the template marks a thought's end.
  `reasoning_format` is not sent: left as it is, the server takes what a
  model thought out of the content.
- `cache_prompt` of false: the most private thing a request can say. Left
  unsaid, the server keeps a prompt's tokens in its slot to match the next
  request against, and saves idle slots in its memory. What it costs is
  speed: a prefix two prompts share is read again each time.
- The format's `name` is sent as the API requires. The server does not read
  it.

**A prompt and its budget are checked before anything is asked for.** The
server refuses a prompt that alone does not fit a slot. It does not refuse a
budget that does not fit beside the prompt: it writes until the slot is full
and stops for `length`, as it does when the budget ends a reply, so a reply
the window cut short reads as one its budget cut short. So a request whose
prompt and budget are over the window is refused here, and nothing is sent,
by the check and the estimate the Ollama driver refuses by
(`semiont_inference._estimate`). The estimate is not the server's count: a
prompt it lets through and the server finds too large is the server's 400.

**A schema is enforced by construction.** The server turns the schema into a
grammar on its sampler, and a token the grammar does not allow cannot be
sampled. It does that for whatever model it loads, and takes an array at the
root and a property left out of `required`. The grammar lets a model fence
its answer and think before it, and the server is read to return the answer
alone as the content: a fence that reached the content would be a reply that
is not the array, which is a failure here.

What takes the enforcement away, and is not reported in a reply: a server
started with `--skip-chat-parsing`, which reads the schema and does not apply
it. The reply is then text held to nothing, and what of it is not the array
asked for is a failure here.

**An answer withheld.** The server has no filter and signals none: a reply
has no `refusal`, and `content_filter` is not among its reasons for stopping.
What a model declines, it declines in its text. So this driver never raises
`ProviderWithheldError`.

**What a reply says of thinking.** The server returns what a model thought
as `reasoning_content`, beside the content. The answer is read from the
content alone, and a thought that came all the same is warned of.

**Timeouts, and asking again.** As those two modules state them: no bound on
a generation's read, five minutes for the model list, and two more tries for
what the library asks again for. For this server those are a 500 from a
generation that failed, and a 503 while a model loads, which two tries do not
outlast.

**What only the operator decides.** The server logs prompts and answers when
started with `-v` or with `--log-prompts-dir`, and saves slots to files when
started with `--slot-save-path`. Its `GET /slots` is on unless started with
`--no-slots`. Started with `--context-shift`, it drops the oldest tokens of a
full slot and goes on writing: what was sent is lost, and nothing says so.
"""

from typing import Final, final

from pydantic import JsonValue

from semiont_inference._estimate import estimate_that_fits
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
        "The llama.cpp driver needs OpenAI's `openai` library, which is not installed. "
        "It comes with the extra: install `semiont-inference[llamacpp]`.",
        name="openai",
    ) from missing

__all__ = ["LlamaCppInferenceClient"]


def _names(entry: dict[str, JsonValue]) -> list[str]:
    """The names a model is served under: its `id`, which is the first of them, and its `aliases`."""
    aliases = entry.get("aliases")
    stated = (entry.get("id"), *(aliases if isinstance(aliases, list) else ()))
    return list(dict.fromkeys(name for name in stated if isinstance(name, str)))


@final
class LlamaCppInferenceClient:
    """The model `model`, served by the llama.cpp server at `base_url`.

    `api_key` is the key the server was started with, or None for a server
    started with none.
    """

    def __init__(self, *, model: str, base_url: str, api_key: str | None) -> None:
        self.provider: Final = "llamacpp"
        self.model_id: Final = model
        # One at a time. Started as it is by default, the server has four slots over one buffer,
        # and the window it states is the whole buffer: what one call may use if the others leave
        # it room. A caller sizes each call against that window, so two at once can ask for more
        # than there is, and what the server then does was not found. An operator who gave each
        # slot a window of its own (`--kv-unified-per-slot`, `--no-kv-unified`) has room for as
        # many calls as slots, which the server states as `total_slots` of its `/props`; nothing
        # here reads that. It is also one local model, whose speed is its hardware's. Nothing has
        # been measured against a llama.cpp server.
        self.max_concurrency: Final = 1
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
            own={"reasoning_effort": "none", "reasoning_budget_tokens": 0, "cache_prompt": False},
            thinking="reasoning_content",
        )
        self._limits: Final = Once(self._discover_limits)

    async def limits(self) -> InferenceLimits:
        return await self._limits.get()

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        await self._refuse_what_does_not_fit(prompt, max_tokens)
        return await self._server.generate_text(prompt, max_tokens, temperature)

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        await self._refuse_what_does_not_fit(prompt, max_tokens)
        return await self._server.generate_structured(prompt, max_tokens, temperature, element_schema)

    async def _refuse_what_does_not_fit(self, prompt: str, max_tokens: int) -> None:
        """Raise for a prompt and a budget that are over the model's window, by the estimate. Nothing has been sent."""
        estimate_that_fits(prompt, max_tokens, model=self.model_id, context_tokens=(await self.limits()).context_tokens)

    async def _discover_limits(self) -> InferenceLimits:
        listed = await self._server.models()
        entry = next((one for one in listed if self.model_id in _names(one)), None)
        if entry is None:
            served = ", ".join(dict.fromkeys(name for one in listed for name in _names(one))) or "no model"
            raise RuntimeError(f"llama.cpp's model list has no model '{self.model_id}'. It lists: {served}")
        meta = entry.get("meta")
        window = count(meta.get("n_ctx")) if isinstance(meta, dict) else None
        if window is None or window <= 0:
            raise RuntimeError(
                f"llama.cpp's model list reports no meta.n_ctx for '{self.model_id}'. The server states none for a model that is "
                "loading, or that it has not loaded."
            )
        # One window: what goes in and what comes out draw on the same slot, and the server states
        # no separate ceiling on what comes out. So the window is stated as both.
        return InferenceLimits(context_tokens=window, max_output_tokens=window, output_tokens_per_hour=None, accepts_temperature=True)
