"""What the vLLM driver and the llama.cpp driver do alike, against a Chat Completions server this test plays over HTTP.

Both reach their server through OpenAI's own library, by one implementation
they share (`semiont_inference._chat_completions`), which no caller imports:
each case here is run through each driver. The library is not replaced or
patched: it sends real requests to the stand-in, which answers from what a
test scripted. What arrives is held exactly, the headers too.

What is one server's own (where its model list states a window, what its
requests say of thinking and of its cache, llama.cpp's check that a prompt
fits) is in `tests/test_vllm.py` and `tests/test_llamacpp.py`.
"""

import asyncio
import itertools
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import final

import openai
import pytest
from aio import hurried, pass_time, run, settle, soon
from provider import HANG_UP, HOLD, Answer, saying
from provider_chat_completions import (
    ChatCompletions,
    Completed,
    alone,
    choice,
    completed,
    listing,
    llamacpp_entry,
    llamacpp_error,
    spent,
    vllm_entry,
    vllm_error,
    whole,
)
from pydantic import JsonValue, TypeAdapter
from spec import PACKAGE, SPEC, JsonObject, objects, read, text, thing

from semiont_inference.interface import (
    InferenceClient,
    InferenceLimits,
    InferenceResponse,
    ProviderStatusError,
    StructuredReadError,
    StructuredResponse,
    TokenUsage,
)
from semiont_inference.llamacpp import LlamaCppInferenceClient
from semiont_inference.vllm import VllmInferenceClient

MODEL = "served-model"
KEY = "sk-played-key"
COUNTED = TokenUsage(input_tokens=10, output_tokens=5)

_JSON = TypeAdapter[JsonValue](JsonValue)

ELEMENT: JsonObject = {"type": "object", "properties": {"exact": {"type": "string"}}, "required": ["exact"], "additionalProperties": False}
# `prefix` and `suffix` are optional, as they are in the schemas a worker asks with.
PERSON: JsonObject = {
    "type": "object",
    "properties": {
        "exact": {"type": "string"},
        "entityType": {"type": "string"},
        "prefix": {"type": "string"},
        "suffix": {"type": "string"},
    },
    "required": ["exact", "entityType"],
    "additionalProperties": False,
}


def a_vllm(model: str, base_url: str, api_key: str | None) -> InferenceClient:
    return VllmInferenceClient(model=model, base_url=base_url, api_key=api_key)


def a_llamacpp(model: str, base_url: str, api_key: str | None) -> InferenceClient:
    return LlamaCppInferenceClient(model=model, base_url=base_url, api_key=api_key)


def refused_by_vllm(status: int, message: str) -> Answer:
    return vllm_error(status, {400: "BadRequestError", 404: "NotFoundError", 500: "InternalServerError"}.get(status, "Refused"), message)


def refused_by_llamacpp(status: int, message: str) -> Answer:
    kinds = {400: "invalid_request_error", 401: "authentication_error", 500: "server_error", 503: "unavailable_error"}
    return llamacpp_error(status, kinds.get(status, "refused"), message)


@final
@dataclass(frozen=True, slots=True)
class Server:
    """One of the two servers, as a case here needs it."""

    provider: str
    """The provider's name, as its driver states it."""
    client: Callable[[str, str, str | None], InferenceClient]
    """Its driver, for a model, an address and a key."""
    entry: Callable[[str, int], JsonObject]
    """What its model list says of a model with a window."""
    refused: Callable[[int, str], Answer]
    """A refusal as it states one, with a status and in its own words."""
    own: frozenset[str]
    """The members of a request that are this server's own. `tests/test_<its module>.py` holds what each says."""
    thinking: str
    """The member of a reply's message under which it returns what a model thought."""


VLLM = Server(
    provider="vllm",
    client=a_vllm,
    entry=vllm_entry,
    refused=refused_by_vllm,
    own=frozenset({"reasoning_effort", "cache_salt"}),
    thinking="reasoning",
)
LLAMACPP = Server(
    provider="llamacpp",
    client=a_llamacpp,
    entry=llamacpp_entry,
    refused=refused_by_llamacpp,
    own=frozenset({"reasoning_effort", "reasoning_budget_tokens", "cache_prompt"}),
    thinking="reasoning_content",
)

each_server = pytest.mark.parametrize("server", [pytest.param(VLLM, id="vllm"), pytest.param(LLAMACPP, id="llamacpp")])
each_kind = pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])


def play(server: Server, window: int = 8192) -> ChatCompletions:
    """A stand-in whose model list states `window` for MODEL, in `server`'s own way."""
    return ChatCompletions(listing(server.entry(MODEL, window)))


def driver(server: Server, played: ChatCompletions, api_key: str | None = None) -> InferenceClient:
    return server.client(MODEL, played.base_url, api_key)


def shared(context_tokens: int) -> InferenceLimits:
    """One window for what goes in and what comes out, as each of these servers states a model's."""
    return InferenceLimits(
        context_tokens=context_tokens, max_output_tokens=context_tokens, output_tokens_per_hour=None, accepts_temperature=True
    )


def alike(server: Server, body: JsonObject) -> JsonObject:
    """What a request says that either server is sent, once it is seen to carry every member that is this server's own."""
    assert server.own <= set(body), f"the request lacks {sorted(server.own - set(body))}"
    return {name: value for name, value in body.items() if name not in server.own}


def said_to(prompt: str, max_completion_tokens: int, temperature: float, **rest: JsonValue) -> JsonObject:
    """A request for plain text, as it arrives: the model, the prompt as one user message, the budget, the temperature, and `rest`."""
    return {
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_completion_tokens": max_completion_tokens,
        "temperature": temperature,
        **rest,
    }


def held_to(schema: JsonObject) -> JsonObject:
    """What a structured request carries beside the rest: an array of elements of `schema`, as written, under a name."""
    return {"type": "json_schema", "json_schema": {"name": "elements", "schema": {"type": "array", "items": schema}}}


def array(*items: JsonValue) -> str:
    """A reply's text, as a model held to an array writes it."""
    return _JSON.dump_json([*items]).decode()


async def generation(client: InferenceClient, structured: bool) -> InferenceResponse | StructuredResponse:
    if structured:
        return await client.generate_structured("p", 100, 0, ELEMENT)
    return await client.generate_text("p", 100, 0)


def ours(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_inference"]


def at_level(caplog: pytest.LogCaptureFixture, level: int) -> list[logging.LogRecord]:
    return [record for record in ours(caplog) if record.levelno == level]


async def over(ending: asyncio.Future[InferenceLimits], *, within: float) -> None:
    """Move the loop's clock ahead until `ending` has ended, which is to be `within` that many of its seconds.

    Two seconds at a time: a step is to stay well inside the ten seconds a
    connection is given to open, or a try that opens one while the clock
    moves is taken for a server that cannot be reached.
    """
    passed = 0.0
    while not ending.done():
        assert passed < within, f"it has not ended after {passed} seconds"
        await pass_time(10, step=2)
        passed += 10


# ── the request ─────────────────────────────────────────────────────────


@each_server
def test_plain_text_is_one_request_of_exactly_these_members_beside_the_servers_own(server: Server) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(completed("The Loire."))
            answer = await driver(server, played).generate_text("Name one river of France.", 200, 0.3)
            assert answer == InferenceResponse(text="The Loire.", stop_reason="end_turn", usage=COUNTED)
            (body,) = played.generations
            # One user message, the budget and the temperature. No schema, no stream, no tool, and nothing that labels the request.
            assert alike(server, body) == said_to("Name one river of France.", 200, 0.3)
            assert played.paths[-1] == "POST /v1/chat/completions"

    run(scenario())


@each_server
def test_a_structured_generation_sends_the_schema_as_written_under_a_name_and_reads_the_array(server: Server) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(
                completed(
                    array(
                        {"exact": "Paris", "entityType": "Place", "suffix": " is"},
                        {"exact": 'the "best" café', "entityType": "Place", "prefix": "at "},
                    )
                )
            )
            answer = await driver(server, played).generate_structured("Extract places", 1000, 0, PERSON)
            (body,) = played.generations
            # An array at the root and two properties left optional, as the caller wrote them. No `strict`: neither server reads it.
            assert alike(server, body) == said_to("Extract places", 1000, 0, response_format=held_to(PERSON))
            assert answer == StructuredResponse(
                items=[
                    {"exact": "Paris", "entityType": "Place", "suffix": " is"},
                    {"exact": 'the "best" café', "entityType": "Place", "prefix": "at "},
                ],
                stop_reason="end_turn",
                usage=COUNTED,
            )

    run(scenario())


@each_server
def test_the_temperature_is_always_sent_and_the_limits_say_it_is_taken(server: Server) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(completed("ok"), completed("[]"), completed("ok"))
            client = driver(server, played)
            assert (await client.limits()).accepts_temperature is True
            await client.generate_text("p", 100, 0.3)
            await client.generate_structured("p", 100, 0.9, ELEMENT)
            # A zero is a temperature, and is sent as one.
            await client.generate_text("p", 100, 0)
            assert [body["temperature"] for body in played.generations] == [0.3, 0.9, 0]

    run(scenario())


@each_server
def test_an_element_schema_that_cannot_be_sent_is_refused_and_no_generation_is_asked_for(server: Server) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            bounded: JsonObject = {"type": "object", "properties": {"exact": {"type": "string", "minLength": 1}}, "required": ["exact"]}
            with pytest.raises(ValueError, match=re.escape("`minLength` is a keyword this package does not rewrite")):
                await driver(server, played).generate_structured("p", 100, 0, bounded)
            assert played.completions == []

    run(scenario())


@each_server
@pytest.mark.parametrize("api_key", ["", "   "], ids=["empty", "blank"])
def test_an_empty_key_is_refused_when_the_client_is_made(server: Server, api_key: str) -> None:
    # A key is the one the server was started with, or None for a server started with none. An empty one is neither.
    with pytest.raises(ValueError, match=re.escape("api_key is empty")):
        server.client(MODEL, "http://127.0.0.1:1/v1", api_key)


# ── what the library does unasked ───────────────────────────────────────

# What the library reads from the environment whatever it is given, each set to what a driver must not send.
# Four of the lines name a header a driver states, spelled as the library does not spell it: the library reads
# a name without regard to its case, so a line spelled otherwise still speaks for that header.
UNASKED = {
    "OPENAI_API_KEY": "sk-from-the-environment",
    "OPENAI_ADMIN_KEY": "sk-admin-from-the-environment",
    "OPENAI_BASE_URL": "http://127.0.0.1:1/v1",
    "OPENAI_ORG_ID": "org-from-the-environment",
    "OPENAI_PROJECT_ID": "proj-from-the-environment",
    "OPENAI_CUSTOM_HEADERS": "\n".join(
        [
            "authorization: Bearer sk-custom-from-the-environment",
            "user-agent: from-the-environment",
            "accept: text/html",
            "content-type: text/plain",
            "X-From-The-Environment: 1",
        ]
    ),
}
PROXIES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")

# The headers HTTP itself needs, of a request with no body and of one with a body.
OF_HTTP = {"host", "accept-encoding", "connection"}
OF_A_BODY = {"content-length", "content-type"}


@each_server
@pytest.mark.parametrize("api_key", [KEY, None], ids=["a key", "no key"])
def test_a_request_carries_what_the_driver_states_and_nothing_the_library_or_the_environment_would_add(
    server: Server, api_key: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name, value in UNASKED.items():
        monkeypatch.setenv(name, value)

    async def scenario() -> None:
        async with play(server) as played:
            played.script(completed("ok"), completed("[]"))
            client = driver(server, played, api_key)
            await client.limits()
            await client.generate_text("p", 100, 0)
            await client.generate_structured("p", 100, 0, ELEMENT)
            # The key it was given, whatever the environment says. With none there is no `Authorization` at all:
            # not the word the library was made with, and not the environment's line.
            authorization = {} if api_key is None else {"authorization": f"Bearer {api_key}"}
            stated = {
                "host": played.origin.removeprefix("http://"),
                "accept": "application/json",
                # The library's name and version, and nothing of the machine it runs on.
                "user-agent": f"AsyncOpenAI/Python {openai.__version__}",
                **authorization,
            }

            # The model list is asked with no body, so nothing describes one. Nothing says how long its read may take.
            (listed,) = played.listings
            assert set(listed.headers) == OF_HTTP | set(stated)
            assert {name: listed.headers[name] for name in stated} == stated

            assert len(played.completions) == 2
            for asked in played.completions:
                # The one more is the library's own mark on a request whose answer is asked for as the text it was.
                # It reads the mark back itself, and it cannot be left off.
                assert set(asked.headers) == OF_HTTP | OF_A_BODY | set(stated) | {"x-stainless-raw-response"}
                assert {name: asked.headers[name] for name in (*stated, *OF_A_BODY)} == {
                    **stated,
                    "content-length": str(len(asked.body)),
                    "content-type": "application/json",
                }

    run(scenario())


@each_server
def test_a_server_started_with_no_key_is_sent_no_authorization_where_the_environment_names_none_either(
    server: Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The library is made with a word in the key's place, since it refuses to be made with none. That word is not sent.
    for name in UNASKED:
        monkeypatch.delenv(name, raising=False)

    async def scenario() -> None:
        async with play(server) as played:
            played.script(completed("ok"))
            client = driver(server, played, None)
            await client.limits()
            await client.generate_text("p", 100, 0)
            assert played.paths == ["GET /v1/models", "POST /v1/chat/completions"]
            assert ["authorization" in asked.headers for asked in played.asked] == [False, False]

    run(scenario())


def test_left_to_itself_the_library_sends_what_these_drivers_omit(monkeypatch: pytest.MonkeyPatch) -> None:
    # This asks the library itself, so a release that changes what it adds on its own fails here and is read again.
    for name, value in UNASKED.items():
        monkeypatch.setenv(name, value)

    async def scenario() -> None:
        async with play(VLLM) as played:
            played.script(completed("ok"))
            async with openai.AsyncOpenAI(api_key=KEY, base_url=played.base_url, max_retries=0) as library:
                await library.models.list()
                await library.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": "p"}])
            (listed,) = played.listings
            (asked,) = played.completions
            added = {
                # What it says of itself and of the machine.
                "x-stainless-lang",
                "x-stainless-package-version",
                "x-stainless-os",
                "x-stainless-arch",
                "x-stainless-runtime",
                "x-stainless-runtime-version",
                "x-stainless-async",
                "x-stainless-retry-count",
                # How long it waits for each read, after which it sends the request again.
                "x-stainless-read-timeout",
                # What the environment named.
                "openai-organization",
                "openai-project",
                "x-from-the-environment",
            }
            said_by_a_driver = {"accept", "user-agent", "authorization"}
            assert set(listed.headers) - OF_HTTP - said_by_a_driver == added
            assert set(asked.headers) - OF_HTTP - OF_A_BODY - said_by_a_driver == added
            for request in (listed, asked):
                assert request.headers["x-stainless-read-timeout"] == "600"
                # A line of the environment's replaced the key it was given, another named the client, and a
                # third said what is taken in answer.
                assert {name: request.headers[name] for name in ("authorization", "user-agent", "accept")} == {
                    "authorization": "Bearer sk-custom-from-the-environment",
                    "user-agent": "from-the-environment",
                    "accept": "text/html",
                }
            # A fourth said what a body is. A request with none carries no such header, whatever the line says.
            assert asked.headers["content-type"] == "text/plain"
            assert "content-type" not in listed.headers
            # And a request says nothing of thinking or of the server's cache.
            assert asked.json() == {"model": MODEL, "messages": [{"role": "user", "content": "p"}]}

    run(scenario())


@each_server
def test_the_address_it_was_given_is_the_address_asked_whatever_proxy_and_certificates_the_environment_names(
    server: Server, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        async with play(server) as played, play(server) as proxy:
            for name in PROXIES:
                monkeypatch.setenv(name, proxy.origin)
            for name in ("NO_PROXY", "no_proxy"):
                monkeypatch.delenv(name, raising=False)
            monkeypatch.setenv("SSL_CERT_FILE", "/nowhere/certificates.pem")
            played.script(completed("ok"))
            client = driver(server, played)
            # Both of its calls: the model list and a generation.
            assert await client.limits() == shared(8192)
            assert (await client.generate_text("p", 100, 0)).text == "ok"
            assert proxy.asked == []
            assert (len(played.listings), len(played.completions)) == (1, 1)

    run(scenario())


@each_server
def test_a_redirect_is_not_followed_so_a_prompt_goes_nowhere_the_config_did_not_name(server: Server) -> None:
    async def scenario() -> None:
        async with play(server) as played, play(server) as elsewhere:
            elsewhere.script(completed("from elsewhere"))
            played.script(Answer(status=307, headers={"location": f"{elsewhere.base_url}/chat/completions"}))
            with pytest.raises(ProviderStatusError) as redirected:
                await driver(server, played).generate_text("p", 100, 0)
            assert redirected.value.status == 307
            assert elsewhere.asked == []
            assert len(played.completions) == 1

    run(scenario())


@each_server
def test_a_redirected_model_list_is_not_followed_either(server: Server) -> None:
    async def scenario() -> None:
        async with play(server) as played, play(server, 4096) as elsewhere:
            played.models = Answer(status=307, headers={"location": f"{elsewhere.base_url}/models"})
            with pytest.raises(ProviderStatusError, match=re.escape(f"Failed to discover model limits for '{MODEL}'")) as redirected:
                await driver(server, played).limits()
            assert redirected.value.status == 307
            assert elsewhere.asked == []
            assert len(played.listings) == 1

    run(scenario())


# ── the model list ──────────────────────────────────────────────────────


@each_server
def test_the_models_window_is_asked_of_the_server_once_and_kept_and_is_stated_as_both_ceilings(server: Server) -> None:
    async def scenario() -> None:
        async with play(server, 32_768) as played:
            client = driver(server, played)
            # One window: what goes in and what comes out share it, so it is stated as both.
            assert await client.limits() == shared(32_768)
            assert await client.limits() == shared(32_768)
            assert played.paths == ["GET /v1/models"]
            assert played.listings[0].body == b""

    run(scenario())


@each_server
@pytest.mark.parametrize(("status", "asked"), [(401, 1), (404, 1), (500, 3), (503, 3)])
def test_a_model_list_the_server_refuses_is_a_status_error_that_says_what_was_asked_and_the_status_and_is_not_kept(
    server: Server, status: int, asked: int
) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.models = server.refused(status, "what the server said")
            client = driver(server, played)
            with pytest.raises(ProviderStatusError) as refused:
                await client.limits()
            # A refused discovery is classed as a refused generation is, by its status.
            assert (
                str(refused.value)
                == f"Failed to discover model limits for '{MODEL}' from the server's model list: refused with status {status}"
            )
            assert refused.value.status == status
            cause = refused.value.__cause__
            assert isinstance(cause, openai.APIStatusError)
            assert cause.status_code == status
            # The library asks again for the statuses it asks again for, as it does for a generation.
            assert len(played.listings) == asked

            # The server recovers, and the next call asks again.
            played.models = listing(server.entry(MODEL, 4096))
            assert await client.limits() == shared(4096)
            assert len(played.listings) == asked + 1

    run(scenario())


@each_server
def test_a_server_that_cannot_be_reached_for_its_model_list_is_asked_three_times_and_then_the_limits_are_not_learned(
    server: Server,
) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.models = HANG_UP
            with pytest.raises(RuntimeError, match=re.escape(f"Failed to discover model limits for '{MODEL}'")) as unreached:
                await hurried(driver(server, played).limits())
            assert type(unreached.value) is RuntimeError
            assert isinstance(unreached.value.__cause__, openai.APIConnectionError)
            assert len(played.listings) == 3

    run(scenario())


@each_server
@pytest.mark.parametrize(
    "said",
    [
        Answer(headers={"content-type": "text/html"}, body=b"<html>a gateway's page</html>"),
        saying(["not", "an", "object"]),
        saying({"object": "list"}),
        saying({"object": "list", "data": {"id": MODEL}}),
    ],
    ids=["not JSON", "not an object", "no data", "data that is not a list"],
)
def test_an_answer_that_is_not_a_model_list_is_a_plain_error_and_is_not_kept(server: Server, said: Answer) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.models = said
            client = driver(server, played)
            with pytest.raises(
                RuntimeError, match=re.escape(f"Failed to discover model limits for '{MODEL}': the server's answer is not a model list")
            ) as unread:
                await client.limits()
            assert type(unread.value) is RuntimeError
            played.models = listing(server.entry(MODEL, 4096))
            assert await client.limits() == shared(4096)

    run(scenario())


@each_server
def test_callers_that_ask_at_once_share_one_request_for_the_limits(server: Server) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.models = HOLD
            client = driver(server, played)
            first, second = asyncio.ensure_future(client.limits()), asyncio.ensure_future(client.limits())
            await soon(played.arrived("GET", "/v1/models"))
            await settle()
            assert played.holding == 1
            played.release(listing(server.entry(MODEL, 4096)))
            assert list(await soon(asyncio.gather(first, second))) == [shared(4096), shared(4096)]
            assert len(played.listings) == 1

    run(scenario())


@each_server
def test_a_caller_cancelled_while_the_limits_are_being_learned_leaves_at_once_and_the_others_still_get_them(server: Server) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.models = HOLD
            client = driver(server, played)
            leaving, staying = asyncio.ensure_future(client.limits()), asyncio.ensure_future(client.limits())
            await soon(played.arrived("GET", "/v1/models"))
            leaving.cancel()
            with pytest.raises(asyncio.CancelledError):
                await leaving
            assert leaving.cancelled()
            # What is learned once for every caller is not one caller's to end: the request is still open.
            await settle()
            assert not played.closed_by_client.is_set()
            played.release(listing(server.entry(MODEL, 4096)))
            assert await soon(staying) == shared(4096)
            assert len(played.listings) == 1

    run(scenario())


@each_server
def test_the_request_for_the_model_list_is_given_five_minutes_three_times(server: Server) -> None:
    # A model list is answered from what the server holds. One that takes the request and says nothing is given
    # up after five minutes, and the library asks again as it does for any request that timed out: twice.
    async def scenario() -> None:
        async with play(server) as played:
            played.models = HOLD
            asking = asyncio.ensure_future(driver(server, played).limits())
            await soon(played.arrived("GET", "/v1/models"))
            await pass_time(290, step=29)
            assert not asking.done()
            assert len(played.listings) == 1
            await over(asking, within=1000)
            with pytest.raises(RuntimeError, match=re.escape(f"Failed to discover model limits for '{MODEL}'")) as given_up:
                await asking
            assert isinstance(given_up.value.__cause__, openai.APITimeoutError)
            at = [asked.at for asked in played.listings]
            assert len(at) == 3
            # Each try waited its five minutes. The clock is moved a step at a time here, however long a step
            # really takes, so from above only a wait of the wrong size is refused.
            assert all(300 <= later - earlier < 330 for earlier, later in itertools.pairwise(at)), at

    run(scenario())


# ── what comes back ─────────────────────────────────────────────────────


@each_server
@each_kind
def test_the_answer_is_the_content_alone_and_what_the_model_thought_all_the_same_is_warned_of_with_its_size(
    server: Server, structured: bool, caplog: pytest.LogCaptureFixture
) -> None:
    # A driver cannot stop a model that thinks though it was asked not to. It can say that it did: the
    # thought was generated, and is counted among the tokens written.
    final_answer = array({"exact": "Paris"}) if structured else "The Loire."

    async def scenario() -> None:
        async with play(server) as played:
            played.script(Completed(content=final_answer, usage=spent(10, 5), beside={server.thinking: "x" * 500}))
            answer = await generation(driver(server, played), structured)
            if structured:
                assert answer == StructuredResponse(items=[{"exact": "Paris"}], stop_reason="end_turn", usage=COUNTED)
            else:
                assert answer == InferenceResponse(text="The Loire.", stop_reason="end_turn", usage=COUNTED)

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (warned,) = at_level(caplog, logging.WARNING)
    assert re.search("thinking", warned.getMessage(), re.IGNORECASE)
    assert (vars(warned)["model"], vars(warned)["thinkingChars"]) == (MODEL, 500)


@each_server
@pytest.mark.parametrize("thought", [None, ""], ids=["null", "empty"])
def test_a_reply_with_no_thought_in_it_warns_of_none_and_neither_does_the_other_servers_name_for_one(
    server: Server, thought: str | None, caplog: pytest.LogCaptureFixture
) -> None:
    # vLLM returns a thought as `reasoning` and llama.cpp as `reasoning_content`: each driver reads its own server's.
    another = {VLLM.thinking: LLAMACPP.thinking, LLAMACPP.thinking: VLLM.thinking}[server.thinking]

    async def scenario() -> None:
        async with play(server) as played:
            played.script(
                Completed(content="ok", usage=spent(10, 5), beside={server.thinking: thought}),
                Completed(content="ok", usage=spent(10, 5), beside={another: "x" * 500}),
            )
            client = driver(server, played)
            assert (await client.generate_text("p", 100, 0)).text == "ok"
            assert (await client.generate_text("p", 100, 0)).text == "ok"

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    assert at_level(caplog, logging.WARNING) == []


@each_server
@pytest.mark.parametrize(
    ("finish_reason", "answered"),
    [
        ("stop", "end_turn"),
        ("length", "max_tokens"),
        ("tool_calls", "tool_calls"),
        ("repetition", "repetition"),
        ("abort", "abort"),
        (None, "unknown"),
        ("", "unknown"),
    ],
)
def test_why_the_model_stopped_is_the_interfaces_word_where_it_has_one_and_otherwise_the_servers(
    server: Server, finish_reason: str | None, answered: str
) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(completed("text", finish_reason=finish_reason), completed("[]", finish_reason=finish_reason))
            client = driver(server, played)
            assert (await client.generate_text("p", 100, 0)).stop_reason == answered
            assert (await client.generate_structured("p", 100, 0, ELEMENT)).stop_reason == answered

    run(scenario())


@each_server
def test_a_reply_cut_off_by_the_budget_stops_for_max_tokens_and_what_it_had_written_is_its_text(server: Server) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(completed("The Loire is", finish_reason="length", usage=spent(10, 100)))
            assert await driver(server, played).generate_text("p", 100, 0) == InferenceResponse(
                text="The Loire is", stop_reason="max_tokens", usage=TokenUsage(input_tokens=10, output_tokens=100)
            )

    run(scenario())


@each_server
@each_kind
@pytest.mark.parametrize("content", [None, ""], ids=["null", "empty"])
@pytest.mark.parametrize("thought", [None, "I will look for rivers first."], ids=["no thought", "a thought"])
def test_a_reply_cut_off_before_its_first_character_is_a_failure_that_carries_the_stop_reason(
    server: Server, structured: bool, content: str | None, thought: str | None, caplog: pytest.LogCaptureFixture
) -> None:
    # A model that thinks before it answers can spend the whole budget first: vLLM then says the content is
    # null, and llama.cpp that it is empty. Cut off before its first character is still cut off: the failure
    # says so, and is not an empty text or an unreadable one.
    async def scenario() -> None:
        async with play(server) as played:
            beside: JsonObject = {} if thought is None else {server.thinking: thought}
            played.script(Completed(content=content, usage=spent(10, 100), finish_reason="length", beside=beside))
            with pytest.raises(StructuredReadError) as empty:
                await generation(driver(server, played), structured)
            assert (empty.value.stop_reason, str(empty.value)) == (
                "max_tokens",
                "Structured response could not be read: response is empty (stop_reason: max_tokens)",
            )

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (error,) = at_level(caplog, logging.ERROR)
    assert error.getMessage() == "Empty response from the server"
    assert {key: vars(error)[key] for key in ("model", "stopReason", "thinkingChars")} == {
        "model": MODEL,
        "stopReason": "max_tokens",
        "thinkingChars": None if thought is None else len(thought),
    }


@each_server
@each_kind
@pytest.mark.parametrize(
    ("said", "stop_reason"),
    [
        (whole(usage=spent(10, 0)), "unknown"),
        (saying({"id": "chatcmpl-played", "usage": spent(10, 0)}), "unknown"),
        (whole({"index": 0, "finish_reason": "stop"}, usage=spent(10, 0)), "end_turn"),
        (whole({"index": 0, "message": {"role": "assistant"}, "finish_reason": "stop"}, usage=spent(10, 0)), "end_turn"),
        (whole({"index": 0, "message": {"role": "assistant", "content": ["Paris"]}, "finish_reason": "stop"}), "end_turn"),
    ],
    ids=["no choice", "no choices at all", "a choice with no message", "a message with no content", "content that is not text"],
)
def test_a_reply_that_holds_no_text_is_a_failure_and_not_an_empty_answer(
    server: Server, structured: bool, said: Answer, stop_reason: str
) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(said)
            with pytest.raises(StructuredReadError) as empty:
                await generation(driver(server, played), structured)
            assert (empty.value.stop_reason, str(empty.value)) == (
                stop_reason,
                f"Structured response could not be read: response is empty (stop_reason: {stop_reason})",
            )

    run(scenario())


@each_server
@each_kind
def test_a_reply_of_more_than_one_choice_is_a_failure_and_none_of_them_is_chosen(server: Server, structured: bool) -> None:
    # One answer is asked for. Which of two a server sent is the answer is not this driver's to pick.
    async def scenario() -> None:
        async with play(server) as played:
            played.script(whole(choice("[]"), choice("[]", finish_reason="length"), usage=spent(10, 5)))
            with pytest.raises(StructuredReadError) as unread:
                await generation(driver(server, played), structured)
            assert (unread.value.stop_reason, str(unread.value)) == (
                "unknown",
                "Structured response could not be read: the reply holds 2 choices, not one (stop_reason: unknown)",
            )

    run(scenario())


@each_server
@pytest.mark.parametrize(
    "answer",
    [Answer(headers={"content-type": "text/html"}, body=b"<html>a gateway's page</html>"), saying(["not", "an", "object"])],
    ids=["not JSON", "JSON that is not an object"],
)
def test_an_answer_that_is_not_a_json_object_is_a_failure_and_not_an_empty_text(server: Server, answer: Answer) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(answer)
            with pytest.raises(StructuredReadError) as unread:
                await driver(server, played).generate_text("p", 100, 0)
            assert (unread.value.stop_reason, str(unread.value)) == (
                "unknown",
                "Structured response could not be read: the provider's answer is not a JSON object (stop_reason: unknown)",
            )

    run(scenario())


@each_server
@pytest.mark.parametrize(
    ("said", "detail"),
    [
        # A backslash from OCR that was never escaped.
        (completed('[{"exact":"\\Villiam Crookes"}]'), "response is not valid JSON (stop_reason: end_turn)"),
        # Cut off by the budget: the same request is cut off the same way again, which the stop reason lets a worker know.
        (completed('[{"exact":"William Cro', finish_reason="length"), "response is not valid JSON (stop_reason: max_tokens)"),
        # What a server that was started so as not to hold a reply to its schema can answer.
        (completed("I found three places."), "response is not valid JSON (stop_reason: end_turn)"),
        (completed('```json\n[{"exact":"Paris"}]\n```'), "response is not valid JSON (stop_reason: end_turn)"),
        (completed('{"entities":[]}'), "parsed to object, not an array (stop_reason: end_turn)"),
        (completed("[NaN]"), "response is not valid JSON (stop_reason: end_turn)"),
    ],
    ids=["an invalid escape", "cut off", "prose", "a fenced array", "an object", "not a number"],
)
def test_a_reply_that_cannot_be_read_as_the_array_raises_and_is_never_an_empty_one(
    server: Server, said: Completed, detail: str, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(said)
            with pytest.raises(StructuredReadError) as unread:
                await driver(server, played).generate_structured("p", 1000, 0.3, PERSON)
            assert str(unread.value) == f"Structured response could not be read: {detail}"

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (error,) = at_level(caplog, logging.ERROR)
    assert error.getMessage() == "Structured response could not be read"
    assert vars(error)["textLength"] == len(said.content or "")


@each_server
def test_an_empty_array_is_an_answer(server: Server) -> None:
    # The other half: "the model found nothing" is a result, and does not raise.
    async def scenario() -> None:
        async with play(server) as played:
            played.script(completed("[]"))
            answer = await driver(server, played).generate_structured("p", 1000, 0.3, PERSON)
            assert answer == StructuredResponse(items=[], stop_reason="end_turn", usage=COUNTED)

    run(scenario())


@each_server
def test_the_tokens_are_the_servers_on_either_kind_of_generation(server: Server) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            # What was written includes what the model spent thinking, which vLLM also states apart and llama.cpp does not.
            usage: JsonObject = {**spent(412, 57), "completion_tokens_details": {"reasoning_tokens": 40}}
            played.script(completed("text", usage=usage), completed("[]", usage=usage))
            client = driver(server, played)
            told = TokenUsage(input_tokens=412, output_tokens=57)
            assert await client.generate_text("p", 100, 0) == InferenceResponse(text="text", stop_reason="end_turn", usage=told)
            assert await client.generate_structured("p", 100, 0, ELEMENT) == StructuredResponse(
                items=[], stop_reason="end_turn", usage=told
            )

    run(scenario())


@each_server
@pytest.mark.parametrize(
    "usage",
    [None, {}, {"prompt_tokens": 412}, {"completion_tokens": 57}, {"prompt_tokens": "412", "completion_tokens": True}],
    ids=["no usage", "neither", "read alone", "written alone", "counts that are not numbers"],
)
def test_no_tokens_are_answered_where_the_server_did_not_count_both_on_either_kind_of_generation(
    server: Server, usage: JsonObject | None
) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(Completed(content="text", usage=usage), Completed(content="[]", usage=usage))
            client = driver(server, played)
            # Not known is not nothing: a zero would say the call cost nothing.
            assert await client.generate_text("p", 100, 0) == InferenceResponse(text="text", stop_reason="end_turn", usage=None)
            assert await client.generate_structured("p", 100, 0, ELEMENT) == StructuredResponse(
                items=[], stop_reason="end_turn", usage=None
            )

    run(scenario())


@each_server
def test_a_call_logs_what_the_other_drivers_do_at_the_same_levels(server: Server, caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(completed("hello"), completed(array({"exact": "A"})), completed("not an array"))
            client = driver(server, played)
            await client.generate_text("prompt", 100, 0.2)
            await client.generate_structured("prompt", 100, 0.2, ELEMENT)
            with pytest.raises(StructuredReadError):
                await client.generate_structured("prompt", 100, 0.2, ELEMENT)

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    records = ours(caplog)
    assert [(record.levelname, record.getMessage()) for record in records] == [
        ("DEBUG", "Generating text with inference client"),
        ("INFO", "Text generation completed"),
        ("DEBUG", "Generating structured output with inference client"),
        ("INFO", "Structured generation completed"),
        ("DEBUG", "Generating structured output with inference client"),
        ("ERROR", "Structured response could not be read"),
    ]
    asked, finished, _, structured, _, unread = records
    assert {key: vars(asked)[key] for key in ("model", "promptLength", "maxTokens", "temperature")} == {
        "model": MODEL,
        "promptLength": 6,
        "maxTokens": 100,
        "temperature": 0.2,
    }
    # The id the server gave its reply, for telling one generation from another in its log and in ours.
    assert {key: vars(finished)[key] for key in ("model", "textLength", "stopReason", "requestId")} == {
        "model": MODEL,
        "textLength": 5,
        "stopReason": "end_turn",
        "requestId": "chatcmpl-played-1",
    }
    assert {key: vars(structured)[key] for key in ("model", "items", "stopReason", "requestId")} == {
        "model": MODEL,
        "items": 1,
        "stopReason": "end_turn",
        "requestId": "chatcmpl-played-2",
    }
    assert {key: vars(unread)[key] for key in ("model", "textLength", "stopReason")} == {
        "model": MODEL,
        "textLength": 12,
        "stopReason": "end_turn",
    }


# ── failures ────────────────────────────────────────────────────────────


@each_server
@pytest.mark.parametrize(
    ("status", "asked"),
    [(408, 3), (409, 3), (429, 3), (500, 3), (501, 3), (503, 3), (400, 1), (401, 1), (403, 1), (404, 1), (422, 1)],
)
def test_a_refused_generation_is_a_provider_status_error_with_the_librarys_failure_as_its_cause(
    server: Server, status: int, asked: int
) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(*[server.refused(status, "what the server said")] * asked)
            with pytest.raises(ProviderStatusError) as failed:
                await driver(server, played).generate_text("p", 100, 0)
            cause = failed.value.__cause__
            assert isinstance(cause, openai.APIStatusError)
            # What the library said of it, with the status and the server's own words in it.
            assert (failed.value.status, str(failed.value)) == (status, cause.message)
            assert str(status) in str(failed.value)
            assert "what the server said" in str(failed.value)
            # The retries are these drivers' choice of two: a refusal the library asks again for is asked three
            # times in all, the same request each time, and any other once.
            assert [alike(server, body) for body in played.generations] == [said_to("p", 100, 0)] * asked

    run(scenario())


@each_server
def test_a_refusal_followed_by_an_answer_is_an_answer(server: Server) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(server.refused(503, "the queue is full"), completed("[]"))
            assert (await driver(server, played).generate_structured("p", 100, 0, ELEMENT)).items == []
            assert len(played.generations) == 2

    run(scenario())


@each_server
def test_a_connection_that_ends_unanswered_is_asked_three_times_and_then_passed_on_as_the_library_reports_it(server: Server) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(HANG_UP, HANG_UP, HANG_UP)
            with pytest.raises(openai.APIConnectionError) as ended:
                await hurried(driver(server, played).generate_text("p", 100, 0))
            # It carries no status: it is the library's failure, and none of those the interface declares.
            assert not hasattr(ended.value, "status")
            assert len(played.generations) == 3

    run(scenario())


@each_server
def test_a_generation_that_takes_an_hour_is_neither_given_up_nor_asked_a_second_time(server: Server) -> None:
    # The library's own bound is ten minutes for each read, after which it sends the same request again, twice.
    # Either server sends nothing, not a header, until the whole answer is made. So these drivers state no bound
    # on a read: a generation ends when it is answered, or when its caller cancels it.
    async def scenario() -> None:
        async with play(server) as played:
            played.script(HOLD)
            call = asyncio.ensure_future(driver(server, played).generate_text("p", 100, 0))
            await soon(played.arrived("POST", "/v1/chat/completions"))
            await pass_time(3600, step=30)
            assert not call.done()
            assert len(played.completions) == 1
            played.release(whole(choice("at last"), usage=spent(10, 5)))
            assert (await soon(call)).text == "at last"
            assert len(played.completions) == 1

    run(scenario())


# ── cancelling ──────────────────────────────────────────────────────────


@each_server
@each_kind
def test_cancelling_a_generation_ends_its_task_cancelled_and_closes_the_connection(server: Server, structured: bool) -> None:
    async def scenario() -> None:
        async with play(server) as played:
            played.script(HOLD)
            call = asyncio.ensure_future(generation(driver(server, played), structured))
            await soon(played.arrived("POST", "/v1/chat/completions"))
            await settle()
            assert not call.done()
            call.cancel()
            # The cancellation reaches the caller as it is: the library has no abort of its own to report in its place.
            with pytest.raises(asyncio.CancelledError):
                await call
            assert call.cancelled()
            # The server sees the request torn down, which is what makes either of them stop generating, and
            # the library does not ask again for a caller that left.
            await soon(played.closed_by_client.wait())
            await settle()
            assert len(played.completions) == 1

    run(scenario())


# ── telemetry ───────────────────────────────────────────────────────────

# A process has one meter provider, and `tests/test_telemetry.py` installs this one's. So what these drivers record
# is collected by an interpreter of its own, which prints it: generations of one driver that end each way.
RECORDING = """
import asyncio
import json
import sys

tests, provider = sys.argv[1:]
sys.path.insert(0, tests)

from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

reader = InMemoryMetricReader()
metrics.set_meter_provider(MeterProvider(metric_readers=[reader]))

import provider_chat_completions as played_server
from aio import run, soon
from provider import HOLD

from semiont_inference.interface import ProviderStatusError, StructuredReadError
from semiont_inference.llamacpp import LlamaCppInferenceClient
from semiont_inference.vllm import VllmInferenceClient

Driver, entry = {
    "vllm": (VllmInferenceClient, played_server.vllm_entry),
    "llamacpp": (LlamaCppInferenceClient, played_server.llamacpp_entry),
}[provider]
ELEMENT = {"type": "object", "properties": {"exact": {"type": "string"}}, "required": ["exact"]}


async def fails(kind, call):
    try:
        await call
    except kind:
        return
    raise SystemExit(f"no {kind.__name__} was raised")


async def traffic():
    async with played_server.ChatCompletions(played_server.listing(entry("telemetry-model", 8192))) as played:
        played.script(
            played_server.completed("hello", usage=played_server.spent(4127, 571)),
            played_server.completed("not an array", usage=played_server.spent(10, 5)),
            # Nothing in it, and still counted by the server.
            played_server.completed("", finish_reason="length", usage=played_server.spent(7, 3)),
            # Its server reports no tokens: it is counted as a call, and adds none.
            played_server.Completed(content="hello", usage=None),
            played_server.vllm_error(400, "BadRequestError", "temperature must be in [0, 2], got 3."),
            HOLD,
        )
        client = Driver(model="telemetry-model", base_url=played.base_url, api_key=None)
        await client.generate_text("p", 100, 0)
        await fails(StructuredReadError, client.generate_structured("p", 100, 0, ELEMENT))
        await fails(StructuredReadError, client.generate_text("p", 100, 0))
        await client.generate_text("p", 100, 0)
        await fails(ProviderStatusError, client.generate_text("p", 100, 3))
        # A generation its caller cancelled ended, and not well.
        cancelled = asyncio.ensure_future(client.generate_text("p", 100, 0))
        await soon(played.arrived("POST", "/v1/chat/completions", 6))
        cancelled.cancel()
        await fails(asyncio.CancelledError, cancelled)


run(traffic())
print(
    json.dumps(
        [
            {
                "name": metric.name,
                "unit": metric.unit,
                "kind": type(metric.data).__name__,
                "monotonic": getattr(metric.data, "is_monotonic", None),
                "points": [
                    {"attributes": dict(point.attributes), "value": getattr(point, "value", None), "count": getattr(point, "count", None)}
                    for point in metric.data.data_points
                ],
            }
            for resource in reader.get_metrics_data().resource_metrics
            for scope in resource.scope_metrics
            for metric in scope.metrics
            if metric.name.startswith("semiont.inference.")
        ]
    )
)
"""

PREFIX = "semiont.inference."


@each_server
def test_a_generation_is_counted_once_by_how_it_ended_under_its_drivers_own_name_and_by_the_tables_keys(server: Server) -> None:
    # The table every service is held to (`specs/src/service-telemetry/telemetry.json`) lists the three metrics a
    # driver records. Neither of these providers is among the values it lists for `inference.provider`: the
    # protocol's list of providers is closed, and gains each with the service that makes its driver. So the
    # points are held to the table's keys and instruments, and counted.
    rows = {text(row["name"], "a name"): row for row in objects(read(SPEC / "service-telemetry/telemetry.json")["metrics"], "the metrics")}
    listed = {name: row for name, row in rows.items() if name.startswith(PREFIX)}
    assert listed, "the table lists no inference metric: this gate reads nothing"
    printed = alone(RECORDING, str(PACKAGE / "tests"), server.provider)
    recorded = {text(metric["name"], "a name"): metric for metric in objects(_JSON.validate_json(printed), "what was recorded")}
    assert set(recorded) == set(listed)

    calls: dict[str, JsonValue] = {}
    tokens: dict[str, JsonValue] = {}
    timed: dict[str, JsonValue] = {}
    for name, row in listed.items():
        metric = recorded[name]
        match text(row["instrument"], "an instrument"):
            case "counter":
                assert (metric["kind"], metric["monotonic"]) == ("Sum", True), f"{name} is not a counter"
            case "histogram":
                assert metric["kind"] == "Histogram", f"{name} is not a histogram"
            case other:
                raise AssertionError(f"{name} is listed as a {other}, which this test does not know how to hold")
        keys = {text(attribute["key"], "a key") for attribute in objects(row["attributes"], "the attributes")}
        points = objects(metric["points"], "the points")
        assert points, f"no {name} was recorded"
        for point in points:
            attributes = thing(point["attributes"], "the attributes")
            assert set(attributes) == keys, f"{name} carries {set(attributes)}; the table lists {keys}"
            assert (attributes["inference.provider"], attributes["inference.model"]) == (server.provider, "telemetry-model")
            match name.removeprefix(PREFIX):
                case "calls":
                    calls[text(attributes["inference.outcome"], "an outcome")] = point["value"]
                case "tokens":
                    tokens[text(attributes["inference.direction"], "a direction")] = point["value"]
                case "duration":
                    timed[text(attributes["inference.outcome"], "an outcome")] = point["count"]
                case other:
                    raise AssertionError(f"{other} is a metric this test does not know how to count")

    # Two answered; four not: unreadable, empty, refused, cancelled.
    assert calls == {"success": 2, "error": 4}
    # What the server counted, the failing ones too, and nothing for a call whose server reported none.
    assert tokens == {"input": 4127 + 10 + 7, "output": 571 + 5 + 3}
    # Every generation is timed, the failing ones too, in milliseconds.
    assert timed == calls
    assert recorded["semiont.inference.duration"]["unit"] == "ms"
