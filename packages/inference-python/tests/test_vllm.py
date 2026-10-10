"""What is vLLM's own in its driver, against a vLLM this test plays over HTTP.

Where its model list states a model's window, what its requests say of
thinking and of the server's prefix cache, that a request over the window is
left to the server to refuse, and its extra. What it does as the llama.cpp
driver does is in `tests/test_chat_completions.py`.
"""

import asyncio
import re
import sys

import pytest
from aio import run, soon
from provider import Answer, saying
from provider_chat_completions import ChatCompletions, alone, completed, listing, vllm_entry, vllm_error
from spec import JsonObject

from semiont_inference.interface import InferenceClient, InferenceLimits, ProviderStatusError
from semiont_inference.vllm import VllmInferenceClient

ELEMENT: JsonObject = {"type": "object", "properties": {"exact": {"type": "string"}}, "required": ["exact"], "additionalProperties": False}

# 256 random bits, in the 43 characters of URL-safe base64 that vLLM's own description of a salt names.
SALT = re.compile(r"[A-Za-z0-9_-]{43}")


def driver(played: ChatCompletions, model: str = "served", api_key: str | None = None) -> VllmInferenceClient:
    return VllmInferenceClient(model=model, base_url=played.base_url, api_key=api_key)


def shared(context_tokens: int) -> InferenceLimits:
    """One window for what goes in and what comes out, as vLLM states a model's."""
    return InferenceLimits(
        context_tokens=context_tokens, max_output_tokens=context_tokens, output_tokens_per_hour=None, accepts_temperature=True
    )


def salts(played: ChatCompletions) -> list[str]:
    """The salt of every generation `played` was asked for, in order, each seen to be one."""
    found: list[str] = []
    for body in played.generations:
        salt = body["cache_salt"]
        assert isinstance(salt, str)
        assert SALT.fullmatch(salt), salt
        found.append(salt)
    return found


def without(entry: JsonObject, member: str) -> JsonObject:
    """`entry`, which states no `member` at all."""
    return {name: value for name, value in entry.items() if name != member}


# ── what it is ──────────────────────────────────────────────────────────


def test_it_is_a_client_of_the_provider_vllm_and_says_what_a_worker_asks_of_any_client() -> None:
    client: InferenceClient = VllmInferenceClient(model="served", base_url="http://127.0.0.1:1/v1", api_key=None)
    assert (client.provider, client.model_id, client.max_concurrency, client.verify_detection_yield) == ("vllm", "served", 4, True)


# ── limits ──────────────────────────────────────────────────────────────


def test_the_window_is_the_max_model_len_of_its_own_entry_among_whatever_else_the_server_lists() -> None:
    async def scenario() -> None:
        async with ChatCompletions(
            listing(vllm_entry("another", 4096), vllm_entry("served", 32_768), vllm_entry("an-adapter", None, parent="another"))
        ) as played:
            client = driver(played)
            assert await client.limits() == shared(32_768)
            assert await client.limits() == shared(32_768)
            # vLLM has no request for one model: the list is asked, once.
            assert played.paths == ["GET /v1/models"]

    run(scenario())


@pytest.mark.parametrize(
    "adapter",
    [vllm_entry("an-adapter", None, parent="its-base"), without(vllm_entry("an-adapter", None, parent="its-base"), "max_model_len")],
    ids=["a null window", "no window stated"],
)
def test_an_adapter_states_no_window_and_has_its_parents(adapter: JsonObject) -> None:
    async def scenario() -> None:
        async with ChatCompletions(listing(vllm_entry("another-base", 4096), vllm_entry("its-base", 16_384), adapter)) as played:
            assert await driver(played, "an-adapter").limits() == shared(16_384)
            assert played.paths == ["GET /v1/models"]

    run(scenario())


@pytest.mark.parametrize(
    ("said", "why"),
    [
        (listing(vllm_entry("another", 4096)), "vLLM's model list has no model 'served'. It lists: another"),
        (listing(), "vLLM's model list has no model 'served'. It lists: no model"),
        (listing(vllm_entry("served", 0)), "vLLM's model list reports no max_model_len for 'served'"),
        (listing({**vllm_entry("served", None), "max_model_len": "32768"}), "vLLM's model list reports no max_model_len for 'served'"),
        (listing({**vllm_entry("served", None), "max_model_len": True}), "vLLM's model list reports no max_model_len for 'served'"),
        (listing(vllm_entry("served", None)), "vLLM's model list reports no max_model_len for 'served'"),
        (
            listing(vllm_entry("another", 4096), vllm_entry("served", None, parent="a-base-not-listed")),
            "vLLM's model list reports no max_model_len for 'served'",
        ),
        (
            listing(vllm_entry("its-base", None), vllm_entry("served", None, parent="its-base")),
            "vLLM's model list reports no max_model_len for 'served'",
        ),
    ],
    ids=[
        "another model alone",
        "no model",
        "a window of zero",
        "a window as text",
        "a window that is no number",
        "no window and no parent",
        "an adapter whose parent is not listed",
        "an adapter whose parent states none",
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

            # The server comes to serve the model, and the next call asks again.
            played.models = listing(vllm_entry("served", 8192))
            assert await client.limits() == shared(8192)
            assert len(played.listings) == 2

    run(scenario())


# ── the request ─────────────────────────────────────────────────────────


def test_a_request_asks_for_no_thinking_and_salts_the_servers_cache_beside_what_every_request_says() -> None:
    async def scenario() -> None:
        async with ChatCompletions(listing(vllm_entry("served", 8192))) as played:
            played.script(completed("The Loire."), completed('[{"exact":"Paris"}]'))
            client = driver(played)
            await client.generate_text("Name one river of France.", 200, 0.3)
            await client.generate_structured("Extract places", 1000, 0, ELEMENT)
            text, structured = played.generations
            salt, _ = salts(played)
            assert text == {
                "model": "served",
                "messages": [{"role": "user", "content": "Name one river of France."}],
                "max_completion_tokens": 200,
                "temperature": 0.3,
                # The least thinking, and a prefix cache no other caller of this server can probe.
                "reasoning_effort": "none",
                "cache_salt": salt,
            }
            assert structured == {
                "model": "served",
                "messages": [{"role": "user", "content": "Extract places"}],
                "max_completion_tokens": 1000,
                "temperature": 0,
                # The `name` vLLM refuses a format without.
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {"name": "elements", "schema": {"type": "array", "items": ELEMENT}},
                },
                "reasoning_effort": "none",
                "cache_salt": salt,
            }
            # A generation asks nothing first: the window is not this driver's to check.
            assert played.paths == ["POST /v1/chat/completions"] * 2

    run(scenario())


def test_every_client_of_one_server_sends_one_salt_and_another_server_is_sent_another() -> None:
    # One salt for a server keeps this process's own prefix cache whole, whichever of its clients asks.
    # A salt a second server never sees is one that server cannot probe the first with.
    async def scenario() -> None:
        async with ChatCompletions(listing(vllm_entry("served", 8192))) as played, ChatCompletions(listing()) as another:
            played.script(completed("ok"), completed("ok"), completed("ok"), completed("ok"))
            another.script(completed("ok"))
            first = driver(played)
            await first.generate_text("p", 100, 0)
            await first.generate_text("q", 100, 0)
            await driver(played, "an-adapter", "sk-a-key").generate_text("p", 100, 0)
            # A slash at the end of the address is not another server.
            await VllmInferenceClient(model="served", base_url=played.base_url + "/", api_key=None).generate_text("p", 100, 0)
            await driver(another).generate_text("p", 100, 0)
            here = set(salts(played))
            (there,) = salts(another)
            assert len(played.generations) == 4
            assert len(here) == 1
            assert there not in here

    run(scenario())


# One generation, asked of the vLLM at the address it is given, by a process of its own.
ANOTHER_PROCESS = """
import asyncio
import sys

from semiont_inference.vllm import VllmInferenceClient

asyncio.run(VllmInferenceClient(model="served", base_url=sys.argv[1], api_key=None).generate_text("p", 100, 0))
"""


def test_another_process_sends_the_same_server_another_salt() -> None:
    # The salt is drawn at random by each process, and is nothing a second one could work out.
    async def scenario() -> None:
        async with ChatCompletions(listing(vllm_entry("served", 8192))) as played:
            played.script(completed("ok"), completed("ok"), completed("ok"))
            await driver(played).generate_text("p", 100, 0)
            for _ in range(2):
                process = await asyncio.create_subprocess_exec(sys.executable, "-c", ANOTHER_PROCESS, played.base_url)
                assert await soon(process.wait(), within=60.0) == 0
            sent = salts(played)
            assert len(sent) == 3
            assert len(set(sent)) == 3

    run(scenario())


# ── what is left to the server ──────────────────────────────────────────


def test_a_request_over_the_window_is_the_servers_to_refuse_and_its_refusal_states_the_numbers() -> None:
    said = (
        "This model's maximum context length is 2048 tokens. However, you requested 500 output tokens and your prompt "
        "contains 10000 input tokens, for a total of 10500 tokens. Please reduce the length of the input prompt or the "
        "number of requested output tokens."
    )

    async def scenario() -> None:
        async with ChatCompletions(listing(vllm_entry("served", 2048))) as played:
            played.script(vllm_error(400, "BadRequestError", said))
            with pytest.raises(ProviderStatusError) as refused:
                await driver(played).generate_text("x" * 40_000, 500, 0.3)
            assert refused.value.status == 400
            assert said in str(refused.value)
            # It was sent, once, and nothing was asked first: no estimate of this driver's stands in for the server's count.
            assert played.paths == ["POST /v1/chat/completions"]

    run(scenario())


def test_a_wrong_key_is_a_status_error_though_its_body_is_not_shaped_as_vllms_other_refusals_are() -> None:
    # A server started with a key answers 401 with an `error` that is a word, and not an object.
    async def scenario() -> None:
        async with ChatCompletions(listing(vllm_entry("served", 8192))) as played:
            played.script(saying({"error": "Unauthorized"}, status=401))
            with pytest.raises(ProviderStatusError) as refused:
                await driver(played, api_key="sk-not-the-servers").generate_text("p", 100, 0)
            assert refused.value.status == 401
            assert "Unauthorized" in str(refused.value)
            assert len(played.completions) == 1

    run(scenario())


# ── its extra ───────────────────────────────────────────────────────────

# The modules of OpenAI's library, and of the HTTP library it brings, that a program has imported.
LOADED = 'sorted(name for name in sys.modules if name.split(".")[0] in ("httpx2", "openai"))'

ASKING_FOR_VLLM = f"""
import sys
import semiont_inference
from semiont_inference.interface import InferenceLimits

before = {LOADED}
from semiont_inference.vllm import VllmInferenceClient

client = VllmInferenceClient(model="served", base_url="http://127.0.0.1:1/v1", api_key=None)
print(before, client.provider, "openai" in sys.modules, "httpx2" in sys.modules, "semiont_inference.vllm" in sys.modules)
"""

WITHOUT_OPENAIS_LIBRARY = """
import sys

sys.modules["openai"] = None  # as an interpreter has it where the library is not installed
from semiont_inference.factory import create_inference_client

try:
    import semiont_inference.vllm
except ModuleNotFoundError as missing:
    print(type(missing).__name__, "|", missing.name, "|", type(missing.__cause__).__name__, "|", missing)
print(create_inference_client(provider="ollama", model="llama3", base_url="http://127.0.0.1:1", api_key=None).provider)
"""

WITHOUT_WHAT_THE_LIBRARY_NEEDS = """
import sys

sys.modules["httpx2"] = None  # the library is installed, and something it imports is not

try:
    import semiont_inference.vllm
except ModuleNotFoundError as missing:
    print(type(missing).__name__, "|", missing.name, "|", "semiont-inference" in str(missing))
"""


def test_asking_for_the_vllm_driver_is_what_imports_openais_library() -> None:
    assert alone(ASKING_FOR_VLLM) == "[] vllm True True True\n"


def test_without_openais_library_the_vllm_driver_fails_naming_its_extra_and_an_ollama_client_is_made() -> None:
    said = (
        "The vLLM driver needs OpenAI's `openai` library, which is not installed. "
        "It comes with the extra: install `semiont-inference[vllm]`."
    )
    assert alone(WITHOUT_OPENAIS_LIBRARY).splitlines() == [f"ModuleNotFoundError | openai | ModuleNotFoundError | {said}", "ollama"]


def test_a_module_the_library_itself_lacks_is_another_failure_and_is_left_as_it_is() -> None:
    assert alone(WITHOUT_WHAT_THE_LIBRARY_NEEDS) == "ModuleNotFoundError | httpx2 | False\n"
