"""What is llama.cpp's own in its driver, against a llama.cpp server this test plays over HTTP.

Where its model list states a model's window, what its requests say of
thinking and of the server's cache, the check that a prompt and its budget
fit before anything is asked for, and its extra. What it does as the vLLM
driver does is in `tests/test_chat_completions.py`.
"""

import re

import pytest
from aio import run
from provider import Answer
from provider_chat_completions import ChatCompletions, alone, completed, listing, llamacpp_entry, llamacpp_error
from spec import JsonObject

from semiont_inference.interface import InferenceClient, InferenceLimits, ProviderStatusError
from semiont_inference.llamacpp import LlamaCppInferenceClient

ELEMENT: JsonObject = {"type": "object", "properties": {"exact": {"type": "string"}}, "required": ["exact"], "additionalProperties": False}


def driver(played: ChatCompletions, model: str = "served", api_key: str | None = None) -> LlamaCppInferenceClient:
    return LlamaCppInferenceClient(model=model, base_url=played.base_url, api_key=api_key)


def shared(context_tokens: int) -> InferenceLimits:
    """One window for what goes in and what comes out, as llama.cpp states a slot's."""
    return InferenceLimits(
        context_tokens=context_tokens, max_output_tokens=context_tokens, output_tokens_per_hour=None, accepts_temperature=True
    )


def with_meta(meta: JsonObject) -> JsonObject:
    """The entry of `served`, whose `meta` is `meta`."""
    return {**llamacpp_entry("served", None), "meta": meta}


# ── what it is ──────────────────────────────────────────────────────────


def test_it_is_a_client_of_the_provider_llamacpp_and_says_what_a_worker_asks_of_any_client() -> None:
    client: InferenceClient = LlamaCppInferenceClient(model="served", base_url="http://127.0.0.1:1/v1", api_key=None)
    # One call at a time: by default the server's slots share the one window it states.
    assert (client.provider, client.model_id, client.max_concurrency, client.verify_detection_yield) == ("llamacpp", "served", 1, True)


# ── limits ──────────────────────────────────────────────────────────────


def test_the_window_is_the_n_ctx_of_its_own_entry_among_whatever_else_the_server_lists() -> None:
    async def scenario() -> None:
        async with ChatCompletions(listing(llamacpp_entry("another", 4096), llamacpp_entry("served", 16_384))) as played:
            client = driver(played)
            # The window of one slot, and not the one the model was trained with, which the entry states beside it.
            assert await client.limits() == shared(16_384)
            assert await client.limits() == shared(16_384)
            assert played.paths == ["GET /v1/models"]

    run(scenario())


def test_a_model_is_found_by_any_name_the_server_serves_it_under() -> None:
    # A model's `id` is the first of its names. A config may name it by another.
    async def scenario() -> None:
        async with ChatCompletions(
            listing(llamacpp_entry("another", 4096), llamacpp_entry("a-first-name", 16_384, aliases=["a-first-name", "served"]))
        ) as played:
            assert await driver(played).limits() == shared(16_384)

    run(scenario())


@pytest.mark.parametrize(
    ("said", "why"),
    [
        (
            listing(llamacpp_entry("another", 4096, aliases=["another", "its-other-name"])),
            "llama.cpp's model list has no model 'served'. It lists: another, its-other-name",
        ),
        (listing(), "llama.cpp's model list has no model 'served'. It lists: no model"),
        # While a model loads, and in router mode for a model that is not loaded, the server states no `meta`.
        (listing(llamacpp_entry("served", None)), "llama.cpp's model list reports no meta.n_ctx for 'served'"),
        (
            listing({name: value for name, value in llamacpp_entry("served", None).items() if name != "meta"}),
            "llama.cpp's model list reports no meta.n_ctx for 'served'",
        ),
        (listing(with_meta({"n_ctx_train": 131_072})), "llama.cpp's model list reports no meta.n_ctx for 'served'"),
        (listing(with_meta({"n_ctx": 0})), "llama.cpp's model list reports no meta.n_ctx for 'served'"),
        (listing(with_meta({"n_ctx": "8192"})), "llama.cpp's model list reports no meta.n_ctx for 'served'"),
        (listing(with_meta({"n_ctx": True})), "llama.cpp's model list reports no meta.n_ctx for 'served'"),
    ],
    ids=[
        "another model alone",
        "no model",
        "a model that is loading",
        "a model that is not loaded",
        "the trained window alone",
        "a window of zero",
        "a window as text",
        "a window that is no number",
    ],
)
def test_a_list_that_states_no_window_for_the_model_is_a_plain_error_and_is_not_kept(said: Answer, why: str) -> None:
    async def scenario() -> None:
        async with ChatCompletions(said) as played:
            client = driver(played)
            with pytest.raises(RuntimeError, match=re.escape(why)) as unlearned:
                await client.limits()
            # No window is guessed, and nothing about the failure is classified by a status.
            assert type(unlearned.value) is RuntimeError
            assert not hasattr(unlearned.value, "status")

            # The model is loaded, and the next call asks again.
            played.models = listing(llamacpp_entry("served", 8192))
            assert await client.limits() == shared(8192)
            assert len(played.listings) == 2

    run(scenario())


# ── the request ─────────────────────────────────────────────────────────


def test_a_request_asks_for_no_thinking_and_keeps_its_prompt_out_of_the_servers_cache_beside_what_every_request_says() -> None:
    async def scenario() -> None:
        async with ChatCompletions(listing(llamacpp_entry("served", 8192))) as played:
            played.script(completed("The Loire."), completed('[{"exact":"Paris"}]'))
            client = driver(played)
            await client.generate_text("Name one river of France.", 200, 0.3)
            await client.generate_structured("Extract places", 1000, 0, ELEMENT)
            own: JsonObject = {
                # The least thinking: the model's template is told not to think, and a thought it opens all the same is ended at once.
                "reasoning_effort": "none",
                "reasoning_budget_tokens": 0,
                # The prompt is not kept in the slot to be matched against the next request's.
                "cache_prompt": False,
            }
            text: JsonObject = {
                "model": "served",
                "messages": [{"role": "user", "content": "Name one river of France."}],
                "max_completion_tokens": 200,
                "temperature": 0.3,
                **own,
            }
            # The `name` is the API's to require. This server does not read it.
            held_to: JsonObject = {
                "type": "json_schema",
                "json_schema": {"name": "elements", "schema": {"type": "array", "items": ELEMENT}},
            }
            structured: JsonObject = {
                "model": "served",
                "messages": [{"role": "user", "content": "Extract places"}],
                "max_completion_tokens": 1000,
                "temperature": 0,
                "response_format": held_to,
                **own,
            }
            assert played.generations == [text, structured]
            # The window is asked first, once: a generation is checked against it before it is sent.
            assert played.paths == ["GET /v1/models", "POST /v1/chat/completions", "POST /v1/chat/completions"]

    run(scenario())


# ── the check before it asks ────────────────────────────────────────────


def test_a_prompt_and_budget_over_the_window_are_refused_and_no_generation_is_asked_for() -> None:
    # llama.cpp does not refuse a budget that does not fit beside its prompt: it writes until the slot is full
    # and stops for `length`, as if the budget had ended it. So nothing that cannot fit is sent.
    async def scenario() -> None:
        async with ChatCompletions(listing(llamacpp_entry("served", 2048))) as played:
            client = driver(played)
            with pytest.raises(
                ValueError, match=re.escape("Prompt (~10000 tokens) + output budget (500) exceed the 'served' context window (2048 tokens)")
            ):
                await client.generate_text("x" * 40_000, 500, 0.3)
            # One token over is over, on either kind of generation.
            with pytest.raises(ValueError, match=re.escape("Prompt (~1549 tokens) + output budget (500) exceed")):
                await client.generate_structured("x" * 6196, 500, 0.3, ELEMENT)
            assert played.paths == ["GET /v1/models"]

    run(scenario())


@pytest.mark.parametrize(
    ("prompt", "max_tokens"),
    [
        # 1548 tokens of prompt and 500 of answer are the window's 2048.
        ("x" * 6192, 500),
        # A token is four code points, rounded up, and not four UTF-16 units: 6192 emoji are 1548 tokens, not 3096.
        ("\U0001f600" * 6192, 500),
        ("", 2048),
    ],
    ids=["the window filled", "code points", "no prompt"],
)
def test_a_prompt_and_budget_that_fill_the_window_exactly_are_asked_for_on_either_kind(prompt: str, max_tokens: int) -> None:
    async def scenario() -> None:
        async with ChatCompletions(listing(llamacpp_entry("served", 2048))) as played:
            played.script(completed("ok"), completed("[]"))
            client = driver(played)
            assert (await client.generate_text(prompt, max_tokens, 0)).text == "ok"
            assert (await client.generate_structured(prompt, max_tokens, 0, ELEMENT)).items == []
            assert [body["max_completion_tokens"] for body in played.generations] == [max_tokens, max_tokens]

    run(scenario())


def test_a_prompt_the_estimate_let_through_and_the_server_counts_as_too_large_is_the_servers_refusal() -> None:
    # The check is an estimate. What the server counts is the server's to say: a prompt that alone does not
    # fit its slot is refused with a status, and the numbers beside it.
    said = "request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it"

    async def scenario() -> None:
        async with ChatCompletions(listing(llamacpp_entry("served", 8192))) as played:
            played.script(llamacpp_error(400, "exceed_context_size_error", said, beside={"n_prompt_tokens": 9000, "n_ctx": 8192}))
            with pytest.raises(ProviderStatusError) as refused:
                await driver(played).generate_text("x" * 20_000, 100, 0)
            assert refused.value.status == 400
            assert said in str(refused.value)
            assert "exceed_context_size_error" in str(refused.value)
            assert len(played.completions) == 1

    run(scenario())


# ── its extra ───────────────────────────────────────────────────────────

# The modules of OpenAI's library, and of the HTTP library it brings, that a program has imported.
LOADED = 'sorted(name for name in sys.modules if name.split(".")[0] in ("httpx2", "openai"))'

ASKING_FOR_LLAMACPP = f"""
import sys
import semiont_inference
from semiont_inference.interface import InferenceLimits

before = {LOADED}
from semiont_inference.llamacpp import LlamaCppInferenceClient

client = LlamaCppInferenceClient(model="served", base_url="http://127.0.0.1:1/v1", api_key=None)
print(before, client.provider, "openai" in sys.modules, "httpx2" in sys.modules, "semiont_inference.llamacpp" in sys.modules)
"""

WITHOUT_OPENAIS_LIBRARY = """
import sys

sys.modules["openai"] = None  # as an interpreter has it where the library is not installed
from semiont_inference.factory import create_inference_client

try:
    import semiont_inference.llamacpp
except ModuleNotFoundError as missing:
    print(type(missing).__name__, "|", missing.name, "|", type(missing.__cause__).__name__, "|", missing)
print(create_inference_client(provider="ollama", model="llama3", base_url="http://127.0.0.1:1", api_key=None).provider)
"""

WITHOUT_WHAT_THE_LIBRARY_NEEDS = """
import sys

sys.modules["httpx2"] = None  # the library is installed, and something it imports is not

try:
    import semiont_inference.llamacpp
except ModuleNotFoundError as missing:
    print(type(missing).__name__, "|", missing.name, "|", "semiont-inference" in str(missing))
"""


def test_asking_for_the_llamacpp_driver_is_what_imports_openais_library() -> None:
    assert alone(ASKING_FOR_LLAMACPP) == "[] llamacpp True True True\n"


def test_without_openais_library_the_llamacpp_driver_fails_naming_its_extra_and_an_ollama_client_is_made() -> None:
    said = (
        "The llama.cpp driver needs OpenAI's `openai` library, which is not installed. "
        "It comes with the extra: install `semiont-inference[llamacpp]`."
    )
    assert alone(WITHOUT_OPENAIS_LIBRARY).splitlines() == [f"ModuleNotFoundError | openai | ModuleNotFoundError | {said}", "ollama"]


def test_a_module_the_library_itself_lacks_is_another_failure_and_is_left_as_it_is() -> None:
    assert alone(WITHOUT_WHAT_THE_LIBRARY_NEEDS) == "ModuleNotFoundError | httpx2 | False\n"
