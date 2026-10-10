"""The Google driver, against a Gemini Developer API this test plays over HTTP.

The driver reaches the provider through Google's own library, and the library
is not replaced: it sends real requests to the stand-in, which answers each
from what a test scripted. What arrives is held exactly, the headers too.

Google's API states a model's limits and nothing else of it, so a driver asks
the provider those and is handed the rest by whoever makes it. Each case here
states the facts it rests on. One test reads a real catalogue file, and holds
the driver to every entry of Google's in it.

Beside each thing the driver switches off stands a test of the library left
to itself, so that a release of the library that changes what it does on its
own fails here and is read again.
"""

import asyncio
import contextlib
import copy
import dataclasses
import logging
import re
import subprocess
import sys
from collections.abc import AsyncGenerator
from typing import Protocol

import httpx
import pytest
from aio import hurried, pass_time, run, settle, soon
from google import genai
from google.genai import errors, types
from provider import HANG_UP, HOLD, Answer, saying
from provider_google import Generated, Google, blocked, candidate, counted, gemini_model, generated, google_error, said, text_part
from pydantic import JsonValue, TypeAdapter
from spec import PACKAGE, SPEC, JsonObject, objects, read, strings, text, thing

from semiont_inference.catalogue import (
    BudgetTokensOption,
    CatalogueFacts,
    CatalogueLimit,
    EffortOption,
    ReasoningEffort,
    ReasoningOption,
    ToggleOption,
    catalogue_facts,
    read_catalogue,
)
from semiont_inference.google import GoogleInferenceClient
from semiont_inference.interface import (
    InferenceClient,
    InferenceLimits,
    InferenceResponse,
    ProviderStatusError,
    ProviderWithheldError,
    StructuredReadError,
    StructuredResponse,
    TokenUsage,
)

KEY = "played-key"
MODEL = "gemini-x"
GENERATION = Google.generation(MODEL)
CATALOGUE = PACKAGE / "tests/catalogue/model-catalogue.json"
COUNTED = TokenUsage(input_tokens=10, output_tokens=5)

_JSON = TypeAdapter[JsonValue](JsonValue)
_POINTS = TypeAdapter[list[JsonObject]](list[JsonObject])

# From least to most, as the driver's design orders them. A catalogue does not always list them so.
LEAST_FIRST = ("none", "minimal", "low", "medium", "high", "xhigh", "max")

ELEMENT: JsonObject = {"type": "object", "properties": {"exact": {"type": "string"}}, "required": ["exact"], "additionalProperties": False}
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


def levels(*values: ReasoningEffort) -> tuple[ReasoningOption, ...]:
    """Thinking set by a named level, of those named."""
    return (EffortOption(type="effort", values=values),)


def budget(least: int | None, most: int | None) -> BudgetTokensOption:
    """Thinking set by a budget of tokens, from `least` to `most`."""
    return BudgetTokensOption(type="budget_tokens", min=least, max=most)


TOGGLE = ToggleOption(type="toggle")

# A model that does not think: nothing sets its thinking. It holds a reply to a schema, and takes a temperature.
# Its limits here are a catalogue's, and are not what the provider states: no test may see them answered.
PLAIN = CatalogueFacts(
    limit=CatalogueLimit(context=999_999, input=None, output=9_999),
    reasoning=False,
    reasoning_options=None,
    status=None,
    structured_output=True,
    temperature=True,
)
# One whose thinking is set by a level, the least of them `minimal`: Gemini 3 Flash, as a catalogue has it.
LEVELLED = dataclasses.replace(PLAIN, reasoning=True, reasoning_options=levels("minimal", "low", "medium", "high"))
# One whose thinking is a budget that can be nothing: Gemini 2.5 Flash.
BUDGETED = dataclasses.replace(PLAIN, reasoning=True, reasoning_options=(TOGGLE, budget(0, 24_576)))


def driver(played: Google, facts: CatalogueFacts = PLAIN, model: str = MODEL) -> GoogleInferenceClient:
    return GoogleInferenceClient(api_key=KEY, model=model, base_url=played.origin, facts=facts)


def asked_of(prompt: str, max_output_tokens: int, **config: JsonValue) -> JsonObject:
    """A request for plain text, as it arrives: a user's one turn, that nothing is to be kept, the budget, and what `config` states."""
    return {
        "contents": [{"parts": [{"text": prompt}], "role": "user"}],
        "store": False,
        "generationConfig": {"maxOutputTokens": max_output_tokens, **config},
    }


def held_to(element: JsonObject) -> JsonObject:
    """What a structured request's config carries beside the rest: that the reply is JSON, and the schema, an array at its root."""
    return {"responseMimeType": "application/json", "responseJsonSchema": {"type": "array", "items": element}}


def array(*items: JsonValue) -> str:
    """A reply's text, as a model held to the array writes it."""
    return _JSON.dump_json([*items]).decode()


def cut_off(content: JsonObject | None, *, usage: JsonObject | None = None) -> Generated:
    """A reply the budget ended."""
    return Generated(candidates=[candidate(content, finish_reason="MAX_TOKENS")], usage=counted(10, None, 100) if usage is None else usage)


async def generation(client: GoogleInferenceClient, structured: bool) -> InferenceResponse | StructuredResponse:
    if structured:
        return await client.generate_structured("p", 100, 0, ELEMENT)
    return await client.generate_text("p", 100, 0)


def ours(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_inference"]


def logged_errors(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in ours(caplog) if record.levelno == logging.ERROR]


@contextlib.asynccontextmanager
async def left_to_itself(*, vertexai: bool | None, base_url: str | None, api_key: str = KEY) -> AsyncGenerator[genai.Client, None]:
    """Google's library as it makes itself, given a key and no more than a case states. Both of its clients are closed on the way out."""
    library = genai.Client(
        api_key=api_key, vertexai=vertexai, http_options=None if base_url is None else types.HttpOptions(base_url=base_url)
    )
    try:
        yield library
    finally:
        await library.aio.aclose()
        library.close()


class Generating(Protocol):
    """The library's models, asked for one generation by a prompt that is text.

    Its own method takes a prompt of many kinds, one of them an image of a
    library that is not installed here, which a type checker reads as unknown.
    """

    async def generate_content(self, *, model: str, contents: str) -> types.GenerateContentResponse: ...


async def asked_plainly(models: Generating) -> types.GenerateContentResponse:
    """One generation by the library as a case made it: the model, a prompt, and nothing else stated."""
    return await models.generate_content(model=MODEL, contents="p")


# ── what it is ──────────────────────────────────────────────────────────


def test_it_is_a_client_of_the_provider_google_and_says_what_a_worker_asks_of_any_client() -> None:
    client: InferenceClient = GoogleInferenceClient(api_key=KEY, model=MODEL, base_url="http://127.0.0.1:1", facts=PLAIN)
    assert (client.provider, client.model_id, client.max_concurrency, client.verify_detection_yield) == ("google", MODEL, 4, True)


def test_it_has_the_members_of_a_client_and_no_others() -> None:
    def public(of: object) -> set[str]:
        return {name for name in dir(of) if not name.startswith("_")}

    assert public(GoogleInferenceClient(api_key=KEY, model=MODEL, base_url="http://127.0.0.1:1", facts=PLAIN)) == public(InferenceClient)


@pytest.mark.parametrize("empty", ["", "   ", "\n"], ids=["empty", "blank", "a line's end"])
def test_a_client_given_no_key_or_no_address_is_refused_when_it_is_made_and_the_environments_is_never_taken(
    empty: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Google's library takes a key, and an address, from the environment wherever the one it is given is empty.
    monkeypatch.setenv("GOOGLE_API_KEY", "key-from-the-environment")
    monkeypatch.setenv("GOOGLE_GEMINI_BASE_URL", "http://127.0.0.1:1")
    with pytest.raises(ValueError, match=re.escape("api_key is required for the Google inference client")):
        GoogleInferenceClient(api_key=empty, model=MODEL, base_url="http://127.0.0.1:1", facts=PLAIN)
    with pytest.raises(ValueError, match=re.escape("base_url is required for the Google inference client")):
        GoogleInferenceClient(api_key=KEY, model=MODEL, base_url=empty, facts=PLAIN)


def test_left_to_itself_the_library_sends_the_environments_key_in_place_of_an_empty_one(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOOGLE_API_KEY", "key-from-the-environment")

    async def scenario() -> None:
        async with Google() as played:
            played.script(generated("ok"))
            async with left_to_itself(vertexai=False, base_url=played.origin, api_key="") as library:
                await asked_plainly(library.aio.models)
            assert [asked.headers["x-goog-api-key"] for asked in played.generating] == ["key-from-the-environment"]

    run(scenario())


# ── limits ──────────────────────────────────────────────────────────────


def test_it_learns_the_models_limits_from_the_provider_once_and_keeps_them() -> None:
    async def scenario() -> None:
        async with Google() as played:
            client = driver(played)
            # What the model reads and the most it writes: two ceilings, and the provider's. Not the catalogue's numbers.
            stated = InferenceLimits(
                context_tokens=1_048_576, max_output_tokens=65_536, output_tokens_per_hour=None, accepts_temperature=True
            )
            assert await client.limits() == stated
            assert await client.limits() == stated
            assert [f"{asked.method} {asked.path}" for asked in played.asked] == [f"GET /v1beta/models/{MODEL}"]
            (asked,) = played.retrievals
            assert asked.body == b""
            assert asked.headers["x-goog-api-key"] == KEY

    run(scenario())


@pytest.mark.parametrize("temperature", [True, False, None], ids=["taken", "refused", "not stated"])
def test_whether_the_model_takes_a_temperature_is_the_facts_word_whatever_the_provider_says_of_one(temperature: bool | None) -> None:
    # `models.get` states a default temperature for a model that ignores every temperature it is sent: it is no answer to this.
    async def scenario() -> None:
        async with Google() as played:
            client = driver(played, dataclasses.replace(PLAIN, temperature=temperature))
            assert (await client.limits()).accepts_temperature is temperature

    run(scenario())


def test_limits_it_cannot_learn_are_a_plain_error_with_no_status_and_are_not_kept() -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.model = google_error(404, "NOT_FOUND", "models/gemini-unknown is not found for API version v1beta")
            client = driver(played, model="gemini-unknown")
            with pytest.raises(
                RuntimeError, match=re.escape("Failed to discover model limits for 'gemini-unknown' from Google's models.get")
            ) as unlearned:
                await client.limits()
            # A discovery that fails is not a refused generation, whatever status refused it: the library's failure is its cause.
            assert type(unlearned.value) is RuntimeError
            assert not hasattr(unlearned.value, "status")
            assert isinstance(unlearned.value.__cause__, errors.ClientError)

            # A later call asks again.
            played.model = gemini_model(input_token_limit=1000, output_token_limit=100)
            assert await client.limits() == InferenceLimits(
                context_tokens=1000, max_output_tokens=100, output_tokens_per_hour=None, accepts_temperature=True
            )
            assert [asked.path for asked in played.retrievals] == ["/v1beta/models/gemini-unknown"] * 2

    run(scenario())


def test_a_provider_that_refuses_to_say_is_asked_three_times_in_all() -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.model = google_error(503, "UNAVAILABLE", "the provider is overloaded")
            with pytest.raises(RuntimeError, match=f"Failed to discover model limits for '{MODEL}'"):
                await hurried(driver(played).limits())
            assert len(played.retrievals) == 3

    run(scenario())


@pytest.mark.parametrize(
    "model",
    [
        gemini_model(input_token_limit=None),
        gemini_model(output_token_limit=None),
        gemini_model(input_token_limit=None, output_token_limit=None),
    ],
    ids=["what it reads", "what it writes", "neither"],
)
def test_a_model_whose_limits_the_provider_does_not_state_is_refused_and_nothing_stands_in_for_them(model: Answer) -> None:
    # The catalogue's facts hold a limit for this model. It is not answered in the provider's place.
    async def scenario() -> None:
        async with Google() as played:
            played.model = model
            with pytest.raises(RuntimeError, match=re.escape(f"Google's models.get states no input and output token limits for '{MODEL}'")):
                await driver(played).limits()
            assert len(played.retrievals) == 1

    run(scenario())


def test_callers_that_ask_at_once_share_one_asking_and_a_generation_asks_nothing_of_the_model() -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(generated("one"))
            client = driver(played)
            # What a generation needs to know of the model it was handed: it does not wait to learn the limits.
            assert (await client.generate_text("a", 100, 0)).text == "one"
            assert played.retrievals == []
            first, second, third = await soon(asyncio.gather(client.limits(), client.limits(), client.limits()))
            assert first == second == third
            assert len(played.retrievals) == 1

    run(scenario())


def test_a_caller_cancelled_while_the_limits_are_being_learned_leaves_at_once_and_the_others_still_learn() -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.model = HOLD
            client = driver(played)
            leaving = asyncio.ensure_future(client.limits())
            staying = asyncio.ensure_future(client.limits())
            await soon(played.arrived("GET", f"/v1beta/models/{MODEL}"))
            leaving.cancel()
            with pytest.raises(asyncio.CancelledError):
                await leaving
            assert leaving.cancelled()
            await settle()
            assert not played.closed_by_client.is_set()
            played.release(gemini_model(input_token_limit=2000, output_token_limit=200))
            assert await soon(staying) == InferenceLimits(
                context_tokens=2000, max_output_tokens=200, output_tokens_per_hour=None, accepts_temperature=True
            )
            assert len(played.retrievals) == 1

    run(scenario())


def test_a_provider_that_does_not_answer_what_the_limits_are_is_given_up_after_a_minute_three_times_over() -> None:
    # The library states no bound of its own, and takes none from the HTTP client it is handed: left to it, this waits for ever.
    async def scenario() -> None:
        async with Google() as played:
            played.model = HOLD
            call = asyncio.ensure_future(driver(played).limits())
            await pass_time(200, step=0.5)
            assert call.done(), "a request for a model's limits that is not answered is never given up"
            with pytest.raises(RuntimeError, match=f"Failed to discover model limits for '{MODEL}'") as unlearned:
                await call
            assert isinstance(unlearned.value.__cause__, httpx.ReadTimeout)
            assert len(played.retrievals) == 3
            first, second, third = (asked.at for asked in played.retrievals)
            # A minute's wait for each answer, and then the library's pause before it asks again. The loop's clock is
            # moved half a second at a time here, so each is held from below, and from above only loosely.
            assert 61.0 <= second - first < 63.5, second - first
            assert 62.0 <= third - second < 64.5, third - second

    run(scenario())


# ── the request ─────────────────────────────────────────────────────────


def test_plain_text_is_one_request_of_exactly_these_members() -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(generated("The Loire."))
            answer = await driver(played, LEVELLED).generate_text("Name one river of France.", 200, 0.3)
            assert answer == InferenceResponse(text="The Loire.", stop_reason="end_turn", usage=COUNTED)
            # Nothing is to be kept, and the least thinking is asked for. No schema, no tool, no safety setting, no label.
            assert played.generations == [
                asked_of("Name one river of France.", 200, temperature=0.3, thinkingConfig={"thinking_level": "MINIMAL"})
            ]
            assert [f"{asked.method} {asked.path}" for asked in played.asked] == [f"POST /v1beta/models/{MODEL}:generateContent"]

    run(scenario())


def test_a_structured_generation_sends_the_schema_as_written_with_an_array_at_its_root_and_reads_the_array_as_written() -> None:
    async def scenario() -> None:
        async with Google() as played:
            written = copy.deepcopy(PERSON)
            played.script(
                generated(
                    array(
                        {"exact": "Paris", "entityType": "Place", "suffix": " is"},
                        {"exact": 'the "best" café', "entityType": "Place", "prefix": "", "suffix": " in town"},
                    )
                )
            )
            answer = await driver(played, BUDGETED).generate_structured("Extract places", 1000, 0, PERSON)
            assert played.generations == [
                asked_of("Extract places", 1000, temperature=0, thinkingConfig={"thinking_budget": 0}, **held_to(PERSON))
            ]
            # The caller's schema is left as it was, and so is each element: a property left out is left out, an empty one is empty.
            assert written == PERSON
            assert answer == StructuredResponse(
                items=[
                    {"exact": "Paris", "entityType": "Place", "suffix": " is"},
                    {"exact": 'the "best" café', "entityType": "Place", "prefix": "", "suffix": " in town"},
                ],
                stop_reason="end_turn",
                usage=COUNTED,
            )

    run(scenario())


@pytest.mark.parametrize(
    ("options", "least"),
    [
        (levels("minimal", "low", "medium", "high"), {"thinking_level": "MINIMAL"}),
        (levels("low", "medium", "high"), {"thinking_level": "LOW"}),
        (levels("high", "medium", "low"), {"thinking_level": "LOW"}),
        (levels("high", "minimal"), {"thinking_level": "MINIMAL"}),
        (levels("medium", "max", "xhigh"), {"thinking_level": "MEDIUM"}),
        (levels("high"), {"thinking_level": "HIGH"}),
        ((*levels("high"), *levels("medium", "low")), {"thinking_level": "LOW"}),
        ((TOGGLE,), {"thinking_budget": 0}),
        ((TOGGLE, budget(0, 24_576)), {"thinking_budget": 0}),
        ((TOGGLE, budget(512, 24_576)), {"thinking_budget": 0}),
        ((budget(0, 24_576),), {"thinking_budget": 0}),
        ((budget(128, 32_768),), {"thinking_budget": 128}),
        ((budget(512, None), budget(128, 32_768)), {"thinking_budget": 128}),
        ((budget(-1, 32_768), budget(1024, 32_768)), {"thinking_budget": 1024}),
        ((TOGGLE, *levels("low", "high")), {"thinking_budget": 0}),
        ((*levels("none", "low"), TOGGLE), {"thinking_budget": 0}),
        ((budget(128, 32_768), *levels("low", "high")), {"thinking_level": "LOW"}),
        ((budget(0, 24_576), *levels("low", "high")), {"thinking_budget": 0}),
        ((budget(-1, 32_768),), None),
        ((budget(None, 32_768),), None),
        (levels(), None),
        ((), None),
        (None, None),
    ],
    ids=[
        "levels from least to most",
        "low is its least",
        "levels from most to least",
        "two levels in no order",
        "levels the API has not, above one it has",
        "one level",
        "two lists of levels",
        "a toggle alone",
        "a toggle and a budget that can be nothing",
        "a toggle and a budget that cannot be nothing",
        "a budget that can be nothing",
        "a budget that cannot be nothing",
        "two budgets",
        "a budget the model sets itself beside one that states its least",
        "a toggle beside levels",
        "a toggle beside a level the API has not",
        "a budget that cannot be nothing beside levels",
        "a budget that can be nothing beside levels",
        "a budget the model sets itself",
        "a budget of no stated least",
        "a level of no values",
        "no way stated",
        "a model that does not think",
    ],
)
def test_the_least_thinking_the_facts_allow_is_asked_for_by_the_kind_of_option_they_name_on_either_kind_of_generation(
    options: tuple[ReasoningOption, ...] | None, least: JsonObject | None
) -> None:
    # A level and a budget are never sent together: the API refuses the two in one request.
    async def scenario() -> None:
        async with Google() as played:
            played.script(generated("ok"), generated(array()))
            client = driver(played, dataclasses.replace(LEVELLED, reasoning_options=options))
            await client.generate_text("p", 100, 0)
            await client.generate_structured("p", 100, 0, ELEMENT)
            stated: JsonObject = {} if least is None else {"thinkingConfig": least}
            assert played.generations == [
                asked_of("p", 100, temperature=0, **stated),
                asked_of("p", 100, temperature=0, **stated, **held_to(ELEMENT)),
            ]

    run(scenario())


@pytest.mark.parametrize(
    ("options", "named"),
    [(levels("none", "low"), "none"), (levels("max", "xhigh"), "xhigh"), (levels("max"), "max")],
    ids=["none", "xhigh", "max"],
)
def test_a_model_whose_least_level_googles_api_has_not_is_refused_when_its_client_is_made(
    options: tuple[ReasoningOption, ...], named: str
) -> None:
    # No level is sent in its place: one the API does not take is refused there, and one above the least is not the least.
    with pytest.raises(ValueError, match=re.escape(f"names `{named}` as the least reasoning effort of '{MODEL}'")):
        GoogleInferenceClient(
            api_key=KEY, model=MODEL, base_url="http://127.0.0.1:1", facts=dataclasses.replace(LEVELLED, reasoning_options=options)
        )


@pytest.mark.parametrize(("temperature", "sent"), [(True, True), (False, False), (None, False)], ids=["taken", "refused", "not stated"])
def test_a_temperature_is_sent_only_where_the_facts_say_the_model_takes_one(temperature: bool | None, sent: bool) -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(generated("ok"), generated(array()))
            client = driver(played, dataclasses.replace(LEVELLED, temperature=temperature))
            await client.generate_text("p", 100, 0.3)
            await client.generate_structured("p", 100, 0.3, ELEMENT)
            configs = [thing(body["generationConfig"], "the config") for body in played.generations]
            assert [config.get("temperature") for config in configs] == ([0.3, 0.3] if sent else [None, None])
            assert ["temperature" in config for config in configs] == [sent, sent]

    run(scenario())


def test_every_google_entry_of_a_real_catalogue_is_asked_as_the_entry_says() -> None:
    # The facts as a worker gets them: read from a catalogue file, and handed to the driver. What each entry
    # says is read a second time here, from the file as JSON, and by this test's own statement of the rule.
    catalogue = read_catalogue(CATALOGUE)
    entries = thing(thing(thing(read(CATALOGUE)["providers"], "the providers")["google"], "google")["models"], "the models")
    assert len(entries) > 20, "the catalogue has few of Google's models: this test reads little"
    asked_for: set[str | int | None] = set()

    async def scenario() -> None:
        async with Google() as played:
            for model_id, stated in entries.items():
                entry = thing(stated, model_id)
                facts = catalogue_facts(catalogue, "google", model_id)
                assert facts is not None, model_id
                options = [] if entry["reasoning_options"] is None else objects(entry["reasoning_options"], "the options")
                named = [effort for option in options if option["type"] == "effort" for effort in strings(option["values"], "the levels")]
                leasts = [option["min"] for option in options if option["type"] == "budget_tokens"]
                stated_leasts = [least for least in leasts if isinstance(least, int) and least >= 0]
                thinking: JsonObject | None
                if any(option["type"] == "toggle" for option in options) or 0 in stated_leasts:
                    thinking = {"thinking_budget": 0}
                elif named:
                    thinking = {"thinking_level": min(named, key=LEAST_FIRST.index).upper()}
                elif stated_leasts:
                    thinking = {"thinking_budget": min(stated_leasts)}
                else:
                    thinking = None
                takes_temperature = entry["temperature"]
                assert takes_temperature is None or isinstance(takes_temperature, bool)

                client = driver(played, facts, model_id)
                # The limits are the provider's, which the stand-in states the same of every model. The catalogue's are not answered.
                assert await client.limits() == InferenceLimits(
                    context_tokens=1_048_576, max_output_tokens=65_536, output_tokens_per_hour=None, accepts_temperature=takes_temperature
                ), model_id
                played.script(generated("ok"))
                await client.generate_text("p", 100, 0.3)
                expected = asked_of("p", 100)
                config = thing(expected["generationConfig"], "the config")
                if thinking is not None:
                    config["thinkingConfig"] = thinking
                if takes_temperature is True:
                    config["temperature"] = 0.3
                assert played.generating[-1].path == Google.generation(model_id), model_id
                assert played.generations[-1] == expected, model_id
                asked_for.add(None if thinking is None else next(value for value in thinking.values() if isinstance(value, str | int)))

    run(scenario())
    # Models that do not think, ones whose thinking is a level, ones that can be told not to think, and one whose budget has a least.
    assert {None, "MINIMAL", "LOW", 0, 128} <= asked_for, asked_for


def test_an_element_schema_this_package_does_not_know_how_to_send_is_refused_before_any_request() -> None:
    async def scenario() -> None:
        async with Google() as played:
            bounded: JsonObject = {"type": "object", "properties": {"exact": {"type": "string", "minLength": 1}}, "required": ["exact"]}
            with pytest.raises(ValueError, match=re.escape("`minLength` is a keyword this package does not rewrite")):
                await driver(played).generate_structured("p", 100, 0, bounded)
            assert played.asked == []

    run(scenario())


@pytest.mark.parametrize(
    ("element", "said_of_it"),
    [
        (
            {"type": "object", "properties": {"kind": {"type": "string", "const": "place"}}, "required": ["kind"]},
            "`const` is a keyword the provider ignores, so no reply would be held to it (at #/properties/kind)",
        ),
        (
            {"type": "object", "properties": {"kind": {"type": ["string", "null"], "enum": ["place", None]}}},
            "`enum` lists a value that is neither text nor a number, which the provider ignores, so no reply would be held to it "
            "(at #/properties/kind)",
        ),
    ],
    ids=["a const", "an enum that lists null"],
)
def test_an_element_schema_googles_api_would_not_hold_a_reply_to_is_refused_before_any_request(
    element: JsonObject, said_of_it: str
) -> None:
    # Google's API ignores a keyword it does not support, and says nothing: a reply would not be held to what the schema
    # states. Which schemas those are is tests/schema-cases.json's to say, of the dialect this driver sends.
    async def scenario() -> None:
        async with Google() as played:
            with pytest.raises(ValueError, match=re.escape(f"The element schema cannot be rewritten: {said_of_it}")):
                await driver(played).generate_structured("p", 100, 0, element)
            assert played.asked == []

    run(scenario())


# ── what the library does unasked ───────────────────────────────────────

# What the library reads from the environment, each set to what would turn a client elsewhere.
UNASKED = {
    "GOOGLE_GENAI_USE_VERTEXAI": "true",
    "GOOGLE_GENAI_USE_ENTERPRISE": "1",
    "GOOGLE_API_KEY": "key-from-the-environment",
    "GEMINI_API_KEY": "another-key-from-the-environment",
    "GOOGLE_CLOUD_PROJECT": "project-from-the-environment",
    "GOOGLE_CLOUD_LOCATION": "us-central1",
    "GOOGLE_GEMINI_BASE_URL": "http://127.0.0.1:1",
    "GOOGLE_VERTEX_BASE_URL": "http://127.0.0.1:1",
    "GOOGLE_GENAI_CLIENT_MODE": "replay",
    "GOOGLE_GENAI_REPLAYS_DIRECTORY": "/nowhere",
    "GOOGLE_GENAI_REPLAY_ID": "from/the/environment",
    "SSL_CERT_FILE": "/nowhere/certificates.pem",
    "SSL_CERT_DIR": "/nowhere/certificates",
}
PROXIES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")

# The headers of a request: what HTTP itself needs, the key, and the library's name and version.
SENT = {"host", "accept", "accept-encoding", "connection", "content-length", "content-type", "user-agent", "x-goog-api-key"}


def test_a_request_goes_where_this_driver_was_told_and_carries_what_it_states_whatever_the_environment_says(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name, value in UNASKED.items():
        monkeypatch.setenv(name, value)

    async def scenario() -> None:
        async with Google() as played:
            played.script(generated("ok"), generated(array()))
            client = driver(played, LEVELLED)
            await client.limits()
            await client.generate_text("p", 100, 0)
            await client.generate_structured("p", 100, 0, ELEMENT)
            # The Developer API, at the address it was given, and not Vertex, another address or a file of replays.
            assert [f"{asked.method} {asked.path}" for asked in played.asked] == [
                f"GET /v1beta/models/{MODEL}",
                f"POST /v1beta/models/{MODEL}:generateContent",
                f"POST /v1beta/models/{MODEL}:generateContent",
            ]
            for asked in played.asked:
                # A request with no body states no length.
                assert set(asked.headers) == (SENT if asked.body else SENT - {"content-length"})
                assert {name: asked.headers[name] for name in ("host", "content-type", "user-agent", "x-goog-api-key")} == {
                    "host": played.origin.removeprefix("http://"),
                    "content-type": "application/json",
                    # The library's name and version, and nothing of the machine it runs on.
                    "user-agent": f"google-genai-sdk/{genai.__version__}",
                    # The key it was given, whatever the environment says.
                    "x-goog-api-key": KEY,
                }
                assert asked.headers.get("content-length", "0") == str(len(asked.body))

    run(scenario())


def test_left_to_itself_the_library_says_what_python_it_runs_on_twice(monkeypatch: pytest.MonkeyPatch) -> None:
    # This asks the library itself, so a release that changes what it adds on its own fails here and is read again.
    for name in UNASKED:
        monkeypatch.delenv(name, raising=False)

    async def scenario() -> None:
        async with Google() as played:
            played.script(generated("ok"))
            async with left_to_itself(vertexai=False, base_url=played.origin) as library:
                await asked_plainly(library.aio.models)
            (asked,) = played.generating
            assert set(asked.headers) - SENT == {"x-goog-api-client"}
            running_on = f"google-genai-sdk/{genai.__version__} gl-python/{sys.version.split()[0]}"
            assert (asked.headers["user-agent"], asked.headers["x-goog-api-client"]) == (running_on, running_on)
            # And it does not say that nothing is to be kept: a project whose logging was turned on keeps the request.
            assert asked.json() == {"contents": [{"parts": [{"text": "p"}], "role": "user"}]}

    run(scenario())


@pytest.mark.parametrize(
    "switch", ["GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_ENTERPRISE"], ids=["the older switch", "the newer switch"]
)
def test_left_to_itself_the_library_is_turned_to_vertex_by_the_environment_and_takes_its_key_there(
    switch: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in UNASKED:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(switch, "true")

    async def scenario() -> None:
        async with Google() as played:
            async with left_to_itself(vertexai=None, base_url=played.origin) as library:
                # Vertex's own path, which the stand-in does not play.
                with pytest.raises(errors.ClientError):
                    await asked_plainly(library.aio.models)
            vertex = f"/v1beta1/publishers/google/models/{MODEL}:generateContent"
            assert played.unscripted == [f"POST {vertex}"]
            played.unscripted.clear()
            assert [(asked.path, asked.headers["x-goog-api-key"]) for asked in played.asked] == [(vertex, KEY)]

    run(scenario())


def test_left_to_itself_the_library_asks_the_address_the_environment_names_and_takes_its_key_there(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in UNASKED:
        monkeypatch.delenv(name, raising=False)

    async def scenario() -> None:
        async with Google() as elsewhere, Google() as outside:
            monkeypatch.setenv("GOOGLE_GEMINI_BASE_URL", elsewhere.origin)
            # Whatever it might ask of an address that is not this machine's goes to a stand-in: it trusts the environment's proxy.
            for name in PROXIES:
                monkeypatch.setenv(name, outside.origin)
            for name in ("NO_PROXY", "no_proxy"):
                monkeypatch.setenv(name, "127.0.0.1")
            elsewhere.script(generated("from elsewhere"))
            async with left_to_itself(vertexai=False, base_url=None) as library:
                assert (await asked_plainly(library.aio.models)).text == "from elsewhere"
            assert [(asked.path, asked.headers["x-goog-api-key"]) for asked in elsewhere.asked] == [(GENERATION, KEY)]
            assert outside.asked == []

    run(scenario())


def test_left_to_itself_the_library_answers_from_files_where_the_environment_names_a_replay_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("GOOGLE_GENAI_CLIENT_MODE", "GOOGLE_GENAI_REPLAYS_DIRECTORY", "GOOGLE_GENAI_REPLAY_ID"):
        monkeypatch.setenv(name, UNASKED[name])

    async def scenario() -> None:
        async with Google() as played, left_to_itself(vertexai=False, base_url=played.origin) as library:
            with pytest.raises(ValueError, match=re.escape("Replay files do not exist for replay id: from/the/environment")):
                await asked_plainly(library.aio.models)
            assert played.asked == []

    run(scenario())


def test_left_to_itself_the_library_cannot_be_made_where_the_environment_names_certificates_that_are_not_there(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # It reads the environment's certificates whatever HTTP client it is handed, unless it is given them.
    monkeypatch.setenv("SSL_CERT_FILE", UNASKED["SSL_CERT_FILE"])
    with pytest.raises(FileNotFoundError):
        genai.Client(api_key=KEY, vertexai=False, http_options=types.HttpOptions(base_url="http://127.0.0.1:1"))


def test_the_address_it_was_given_is_the_address_asked_whatever_proxy_the_environment_names(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Google() as played, Google() as proxy:
            for name in PROXIES:
                monkeypatch.setenv(name, proxy.origin)
            for name in ("NO_PROXY", "no_proxy"):
                monkeypatch.delenv(name, raising=False)
            played.script(generated("ok"))
            client = driver(played)
            assert (await client.generate_text("p", 100, 0)).text == "ok"
            assert (await client.limits()).context_tokens == 1_048_576
            assert proxy.asked == []
            assert len(played.asked) == 2

    run(scenario())


def test_left_to_itself_the_library_asks_the_proxy_the_environment_names(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in UNASKED:
        monkeypatch.delenv(name, raising=False)

    async def scenario() -> None:
        async with Google() as played, Google() as proxy:
            for name in PROXIES:
                monkeypatch.setenv(name, proxy.origin)
            for name in ("NO_PROXY", "no_proxy"):
                monkeypatch.delenv(name, raising=False)
            async with left_to_itself(vertexai=False, base_url=played.origin) as library:
                with pytest.raises(errors.ClientError):
                    await asked_plainly(library.aio.models)
            # The request went to the proxy, which is asked for the whole address, and the provider saw nothing.
            assert played.asked == []
            assert proxy.unscripted == [f"POST {played.origin}{GENERATION}"]
            proxy.unscripted.clear()

    run(scenario())


def test_neither_of_the_librarys_http_clients_is_made_from_the_environments_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    # A proxy of a kind HTTPX does not know refuses every HTTP client that reads it, when the client is made. The library
    # makes two: the one it asks through, and one for calls that block, which this driver never makes.
    for name in PROXIES:
        monkeypatch.setenv(name, "ftp://127.0.0.1:1")
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)

    async def scenario() -> None:
        async with Google() as played:
            played.script(generated("ok"))
            client = driver(played)
            assert (await client.generate_text("p", 100, 0)).text == "ok"
            assert (await client.limits()).context_tokens == 1_048_576

    run(scenario())
    with pytest.raises(ValueError, match="Unknown scheme for proxy URL"):
        genai.Client(api_key=KEY, vertexai=False, http_options=types.HttpOptions(base_url="http://127.0.0.1:1"))


def test_a_redirect_is_not_followed_so_a_prompt_goes_nowhere_the_config_did_not_name() -> None:
    async def scenario() -> None:
        async with Google() as played, Google() as elsewhere:
            elsewhere.script(generated("from elsewhere"))
            played.script(Answer(status=307, headers={"location": f"{elsewhere.origin}{GENERATION}"}))
            with pytest.raises(ProviderStatusError) as redirected:
                await driver(played).generate_text("p", 100, 0)
            assert redirected.value.status == 307
            assert elsewhere.asked == []
            assert len(played.generating) == 1

    run(scenario())


def test_left_to_itself_the_library_follows_a_redirect_and_takes_the_prompt_and_the_key_with_it() -> None:
    async def scenario() -> None:
        async with Google() as played, Google() as elsewhere:
            elsewhere.script(generated("from elsewhere"))
            played.script(Answer(status=307, headers={"location": f"{elsewhere.origin}{GENERATION}"}))
            async with left_to_itself(vertexai=False, base_url=played.origin) as library:
                assert (await asked_plainly(library.aio.models)).text == "from elsewhere"
            assert [(asked.headers["x-goog-api-key"], asked.json()) for asked in elsewhere.generating] == [
                (KEY, {"contents": [{"parts": [{"text": "p"}], "role": "user"}]})
            ]

    run(scenario())


def test_the_request_is_made_by_httpx_where_the_library_would_take_aiohttp(monkeypatch: pytest.MonkeyPatch) -> None:
    # With aiohttp importable the library makes its requests through it, where it trusts the environment and sends a
    # dropped request a second time on its own. aiohttp is not installed here, so the library is told that it is: the one
    # flag it sets when its import succeeds.
    monkeypatch.setattr("google.genai._api_client.has_aiohttp", True)

    async def scenario() -> None:
        async with Google() as played:
            played.script(generated("ok"), HANG_UP)
            client = driver(played)
            assert (await client.generate_text("p", 100, 0)).text == "ok"
            assert (await client.limits()).context_tokens == 1_048_576
            # And a connection that ends unanswered is HTTPX's failure, asked for once.
            with pytest.raises(httpx.RemoteProtocolError):
                await client.generate_text("p", 100, 0)
            assert len(played.generating) == 2

    run(scenario())


def test_left_to_itself_the_library_reaches_for_aiohttp_wherever_it_can_be_imported(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in UNASKED:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr("google.genai._api_client.has_aiohttp", True)

    async def scenario() -> None:
        async with Google() as played, left_to_itself(vertexai=False, base_url=played.origin) as library:
            # It is not installed here, so reaching for it is all the library does.
            with pytest.raises(NameError, match="aiohttp"):
                await asked_plainly(library.aio.models)
            assert played.asked == []

    run(scenario())


def test_no_loop_of_function_calls_is_entered_and_the_library_says_nothing_of_one(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(generated("ok"), generated(array()), generated("ok"))
            client = driver(played)
            await client.generate_text("p", 100, 0)
            await client.generate_structured("p", 100, 0, ELEMENT)
            assert [record.getMessage() for record in caplog.records if record.name == "google_genai.models"] == []
            async with left_to_itself(vertexai=False, base_url=played.origin) as library:
                await asked_plainly(library.aio.models)
            # Left to itself it runs every generation through its loop of automatic function calls, with no function to call.
            assert [record.getMessage() for record in caplog.records if record.name == "google_genai.models"] == [
                "AFC is enabled with max remote calls: 10."
            ]

    caplog.set_level(logging.INFO)
    run(scenario())


# ── the gate ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("structured_output", "said_of_it"),
    [(False, "says it does not"), (None, "does not say that it does")],
    ids=["the catalogue says it does not", "the catalogue says nothing"],
)
def test_a_model_not_known_to_hold_a_reply_to_a_schema_is_refused_before_any_request(
    structured_output: bool | None, said_of_it: str
) -> None:
    # A generation the provider does not hold to the schema is what turns found entities into an empty result.
    async def scenario() -> None:
        async with Google() as played:
            played.script(generated("It was never built."))
            client = driver(played, dataclasses.replace(PLAIN, structured_output=structured_output), "gemini-legacy")
            with pytest.raises(
                RuntimeError, match=re.escape("Model 'gemini-legacy' is not known to hold a reply to a JSON Schema")
            ) as refused:
                await client.generate_structured("p", 1000, 0.3, PERSON)
            assert type(refused.value) is RuntimeError
            # Whose word it is: the catalogue's, and not the provider's, which states this of no model.
            assert f"the model catalogue it was given {said_of_it}" in str(refused.value)
            assert played.asked == []
            # Plain text wants no schema, and is asked for all the same.
            assert (await client.generate_text("p", 300, 0.2)).text == "It was never built."

    run(scenario())


# ── what comes back ─────────────────────────────────────────────────────


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
def test_the_text_is_the_answers_parts_put_together_and_not_what_the_model_thought_on_the_way_to_it(structured: bool) -> None:
    first, second = ('[{"exact":', '"Paris"}]') if structured else ("The ", "Loire.")

    async def scenario() -> None:
        async with Google() as played:
            played.script(
                Generated(
                    candidates=[
                        candidate(said(text_part("I will look for rivers first.", thought=True), text_part(first), text_part(second)))
                    ],
                    usage=counted(10, 5),
                )
            )
            answer = await generation(driver(played), structured)
            if structured:
                assert answer == StructuredResponse(items=[{"exact": "Paris"}], stop_reason="end_turn", usage=COUNTED)
            else:
                assert answer == InferenceResponse(text="The Loire.", stop_reason="end_turn", usage=COUNTED)

    run(scenario())


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
def test_a_reply_of_more_than_one_candidate_is_a_failure_and_none_of_them_is_chosen(
    structured: bool, caplog: pytest.LogCaptureFixture
) -> None:
    # One candidate is asked for. The library's own `text` takes the first of however many came.
    async def scenario() -> None:
        async with Google() as played:
            played.script(
                Generated(candidates=[candidate(said(text_part(array()))), candidate(said(text_part(array())))], usage=counted(10, 5))
            )
            with pytest.raises(StructuredReadError) as unread:
                await generation(driver(played), structured)
            assert (unread.value.stop_reason, str(unread.value)) == (
                "end_turn",
                "Structured response could not be read: the reply holds 2 candidates, not one (stop_reason: end_turn)",
            )

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (error,) = logged_errors(caplog)
    assert error.getMessage() == "More than one candidate from Google"
    assert {key: vars(error)[key] for key in ("model", "stopReason", "candidates")} == {
        "model": MODEL,
        "stopReason": "end_turn",
        "candidates": 2,
    }


def test_a_reply_cut_off_by_the_budget_stops_for_max_tokens_and_what_it_had_written_is_its_text() -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(cut_off(said(text_part("The Loire is")), usage=counted(10, 40, 60)))
            assert await driver(played).generate_text("p", 100, 0) == InferenceResponse(
                text="The Loire is", stop_reason="max_tokens", usage=TokenUsage(input_tokens=10, output_tokens=100)
            )

    run(scenario())


# The reasons a candidate stops for, as the library lists them, by what this driver makes of each.
FINISHED = {"STOP"}
CUT_OFF = {"MAX_TOKENS"}
# The provider chose to give no answer, or to end one it had begun.
WITHHELD = {"SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"}
# Two more that Google's reference lists and the library does not.
WITHHELD_UNLISTED = {"ESCALATION", "PUP_LIMITED_DISABLED"}
# A model or a request that misbehaved, and reasons of tools and images, which are not asked for: each is the provider's own word.
ANOTHER = {
    "FINISH_REASON_UNSPECIFIED",
    "OTHER",
    "MALFORMED_FUNCTION_CALL",
    "UNEXPECTED_TOOL_CALL",
    "TOO_MANY_TOOL_CALLS",
    "IMAGE_SAFETY",
    "IMAGE_PROHIBITED_CONTENT",
    "IMAGE_RECITATION",
    "IMAGE_OTHER",
    "NO_IMAGE",
    "CONTINUATION",
}
# The reasons a prompt is blocked for, as the library lists them. Any of them is an answer withheld.
BLOCKS = {"BLOCKED_REASON_UNSPECIFIED", "SAFETY", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY", "MODEL_ARMOR", "JAILBREAK"}


@pytest.mark.parametrize(
    ("finish_reason", "answered"),
    [
        ("STOP", "end_turn"),
        ("MAX_TOKENS", "max_tokens"),
        *((reason, reason) for reason in sorted(ANOTHER)),
        # Two that Google's reference lists and the library does not, and one that neither does.
        ("MALFORMED_RESPONSE", "MALFORMED_RESPONSE"),
        ("MISSING_THOUGHT_SIGNATURE", "MISSING_THOUGHT_SIGNATURE"),
        ("A_REASON_OF_TOMORROW", "A_REASON_OF_TOMORROW"),
        ("", "unknown"),
        (None, "unknown"),
    ],
)
def test_why_the_model_stopped_is_the_interfaces_word_where_it_has_one_and_otherwise_the_providers(
    finish_reason: str | None, answered: str
) -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(generated("text", finish_reason=finish_reason), generated(array(), finish_reason=finish_reason))
            client = driver(played)
            assert (await client.generate_text("p", 100, 0)).stop_reason == answered
            assert (await client.generate_structured("p", 100, 0, ELEMENT)).stop_reason == answered

    run(scenario())


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
@pytest.mark.parametrize(
    "content",
    [
        None,
        {"role": "model"},
        said(),
        said(text_part("")),
        said(text_part("I will look for rivers first.", thought=True)),
        said({"inlineData": {"mimeType": "image/png", "data": "AAAA"}}),
    ],
    ids=["no content", "content of no parts", "an empty list of parts", "an empty text", "thoughts alone", "a part that is not text"],
)
def test_a_reply_with_no_text_is_a_failure_that_carries_the_stop_reason(
    structured: bool, content: JsonObject | None, caplog: pytest.LogCaptureFixture
) -> None:
    # Thinking counts against the output asked for, so a model can spend the whole budget before it answers. Cut off
    # before its first character is still cut off: the failure says so, and is not an empty text or an unreadable one.
    async def scenario() -> None:
        async with Google() as played:
            played.script(cut_off(content))
            with pytest.raises(StructuredReadError) as empty:
                await generation(driver(played), structured)
            assert (empty.value.stop_reason, str(empty.value)) == (
                "max_tokens",
                "Structured response could not be read: response is empty (stop_reason: max_tokens)",
            )

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (error,) = logged_errors(caplog)
    assert error.getMessage() == "Empty response from Google"
    assert {key: vars(error)[key] for key in ("model", "stopReason", "thoughtsTokens")} == {
        "model": MODEL,
        "stopReason": "max_tokens",
        "thoughtsTokens": 100,
    }


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
@pytest.mark.parametrize(
    "reply", [Generated(candidates=None, usage=None), Generated(candidates=[], usage=None)], ids=["nothing at all", "no candidates"]
)
def test_a_reply_with_no_candidate_and_no_word_of_why_is_empty_and_its_stop_reason_is_unknown(structured: bool, reply: Generated) -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(reply)
            with pytest.raises(StructuredReadError) as empty:
                await generation(driver(played), structured)
            assert (empty.value.stop_reason, str(empty.value)) == (
                "unknown",
                "Structured response could not be read: response is empty (stop_reason: unknown)",
            )

    run(scenario())


def test_every_reason_the_library_lists_is_read_here_as_finished_cut_off_withheld_or_another() -> None:
    # The library's own lists. A release that adds a reason fails here, and the reason is then read.
    assert {reason.value for reason in types.FinishReason} == FINISHED | CUT_OFF | WITHHELD | ANOTHER
    assert sum(len(kind) for kind in (FINISHED, CUT_OFF, WITHHELD, ANOTHER)) == len(types.FinishReason)
    assert not WITHHELD_UNLISTED & {reason.value for reason in types.FinishReason}
    assert {reason.value for reason in types.BlockedReason} == BLOCKS


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
@pytest.mark.parametrize("reason", sorted(WITHHELD | WITHHELD_UNLISTED))
@pytest.mark.parametrize(
    ("content", "finish_message", "explained"),
    [
        (None, None, ""),
        (said(text_part(array({"exact": "Paris"}))), None, ""),
        (None, "The provider said why.", ": The provider said why."),
    ],
    ids=["with no content", "beside what it had written", "with a word of why"],
)
def test_a_candidate_the_provider_stopped_is_an_answer_withheld_for_the_reason_it_states_and_nothing_it_carried_is_returned(
    structured: bool, reason: str, content: JsonObject | None, finish_message: str | None, explained: str, caplog: pytest.LogCaptureFixture
) -> None:
    # It comes back as any reply does, with nothing where the text would be. Read by the text alone it is an empty
    # reply, or, beside text, an answer. What a withheld reply carries is no answer, however much of one it looks like.
    async def scenario() -> None:
        async with Google() as played:
            played.script(
                Generated(candidates=[candidate(content, finish_reason=reason, finish_message=finish_message)], usage=counted(9, 3))
            )
            with pytest.raises(ProviderWithheldError) as withheld:
                await generation(driver(played), structured)
            assert (withheld.value.reason, str(withheld.value)) == (reason, f"The provider withheld its answer: {reason}{explained}")
            assert len(played.generating) == 1

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (error,) = logged_errors(caplog)
    assert error.getMessage() == "The provider withheld its answer"
    assert {key: vars(error)[key] for key in ("model", "reason", "blocked")} == {"model": MODEL, "reason": reason, "blocked": "answer"}


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
@pytest.mark.parametrize("reason", [*sorted(BLOCKS), "A_BLOCK_OF_TOMORROW"])
def test_a_prompt_the_provider_blocked_is_an_answer_withheld_for_the_reason_it_states(
    structured: bool, reason: str, caplog: pytest.LogCaptureFixture
) -> None:
    # No candidate comes back at all: read by its candidates it is an empty reply of no stated reason, which is asked for again.
    async def scenario() -> None:
        async with Google() as played:
            played.script(blocked(reason))
            with pytest.raises(ProviderWithheldError) as withheld:
                await generation(driver(played), structured)
            assert (withheld.value.reason, str(withheld.value)) == (
                reason,
                f"The provider withheld its answer: the prompt was blocked: {reason}",
            )
            assert len(played.generating) == 1

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (error,) = logged_errors(caplog)
    assert error.getMessage() == "The provider withheld its answer"
    assert {key: vars(error)[key] for key in ("model", "reason", "blocked")} == {"model": MODEL, "reason": reason, "blocked": "prompt"}


def test_a_blocked_prompt_is_withheld_whatever_candidate_came_with_it() -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(
                Generated(
                    candidates=[candidate(said(text_part("The Loire.")))], usage=counted(9, 3), prompt_feedback={"blockReason": "SAFETY"}
                )
            )
            with pytest.raises(ProviderWithheldError) as withheld:
                await driver(played).generate_text("p", 100, 0)
            assert withheld.value.reason == "SAFETY"

    run(scenario())


def test_what_the_provider_says_of_a_prompt_it_did_not_block_withholds_nothing() -> None:
    async def scenario() -> None:
        async with Google() as played:
            rated: JsonObject = {"safetyRatings": [{"category": "HARM_CATEGORY_HARASSMENT", "probability": "NEGLIGIBLE"}]}
            played.script(Generated(candidates=[candidate(said(text_part("The Loire.")))], usage=counted(10, 5), prompt_feedback=rated))
            assert (await driver(played).generate_text("p", 100, 0)).text == "The Loire."

    run(scenario())


@pytest.mark.parametrize(
    "answer",
    [
        Answer(headers={"content-type": "text/html"}, body=b"<html>a gateway's page</html>"),
        saying(["not", "an", "object"]),
        Answer(headers={"content-type": "application/json"}, body=b""),
    ],
    ids=["not JSON", "JSON that is not an object", "nothing"],
)
def test_an_answer_that_is_not_a_json_object_is_a_failure_and_not_an_empty_text(answer: Answer) -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(answer)
            with pytest.raises(StructuredReadError) as unread:
                await driver(played).generate_text("p", 100, 0)
            assert (unread.value.stop_reason, str(unread.value)) == (
                "unknown",
                "Structured response could not be read: the provider's answer is not a JSON object (stop_reason: unknown)",
            )

    run(scenario())


@pytest.mark.parametrize(
    ("reply", "detail"),
    [
        # A backslash from OCR that was never escaped.
        (generated('[{"exact":"\\Villiam Crookes"}]'), "response is not valid JSON (stop_reason: end_turn)"),
        # Cut off by the budget: the same request is cut off the same way again, which the stop reason lets a worker know.
        (cut_off(said(text_part('[{"exact":"William Cro'))), "response is not valid JSON (stop_reason: max_tokens)"),
        (generated('{"elements":[]}'), "parsed to object, not an array (stop_reason: end_turn)"),
        (generated('"none"'), "parsed to string, not an array (stop_reason: end_turn)"),
    ],
    ids=["an invalid escape", "cut off", "an object", "a text"],
)
def test_a_reply_that_cannot_be_read_as_the_array_raises_and_is_never_an_empty_one(reply: Generated, detail: str) -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(reply)
            with pytest.raises(StructuredReadError) as unread:
                await driver(played).generate_structured("p", 1000, 0.3, PERSON)
            assert str(unread.value) == f"Structured response could not be read: {detail}"

    run(scenario())


def test_an_empty_array_is_an_answer() -> None:
    # The other half: "the model found nothing" is a result, and does not raise.
    async def scenario() -> None:
        async with Google() as played:
            played.script(generated(array()))
            answer = await driver(played).generate_structured("p", 1000, 0.3, PERSON)
            assert answer == StructuredResponse(items=[], stop_reason="end_turn", usage=COUNTED)

    run(scenario())


@pytest.mark.parametrize(
    ("usage", "told"),
    [
        # What was written is the answer's tokens and the thoughts' together: Google counts them apart, and bills both.
        (counted(412, 57, 40), TokenUsage(input_tokens=412, output_tokens=97)),
        # A count the API leaves out is one that is nothing: a model that did not think, and one cut off before it answered.
        (counted(412, 57), TokenUsage(input_tokens=412, output_tokens=57)),
        (counted(412, None, 40), TokenUsage(input_tokens=412, output_tokens=40)),
        (counted(412, 0, 0), TokenUsage(input_tokens=412, output_tokens=0)),
        # Not known is not nothing: a zero would say the call cost nothing.
        (counted(412, None), None),
        (counted(None, 57, 40), None),
        ({}, None),
        ({"promptTokenCount": "412", "candidatesTokenCount": True}, None),
        (None, None),
    ],
    ids=[
        "an answer and thoughts",
        "an answer alone",
        "thoughts alone",
        "both stated as nothing",
        "nothing written is stated",
        "nothing read is stated",
        "an empty usage",
        "counts that are not numbers",
        "no usage",
    ],
)
def test_the_tokens_are_the_providers_on_either_kind_of_generation(usage: JsonObject | None, told: TokenUsage | None) -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(
                Generated(candidates=[candidate(said(text_part("text")))], usage=usage),
                Generated(candidates=[candidate(said(text_part(array())))], usage=usage),
            )
            client = driver(played)
            assert await client.generate_text("p", 100, 0) == InferenceResponse(text="text", stop_reason="end_turn", usage=told)
            assert await client.generate_structured("p", 100, 0, ELEMENT) == StructuredResponse(
                items=[], stop_reason="end_turn", usage=told
            )

    run(scenario())


def test_a_call_logs_what_the_other_drivers_do_at_the_same_levels(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(generated("hello"), generated(array({"exact": "A"})), generated("not an array"))
            client = driver(played)
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
    asked, completed, _, structured, _, unread = records
    assert {key: vars(asked)[key] for key in ("model", "promptLength", "maxTokens", "temperature")} == {
        "model": MODEL,
        "promptLength": 6,
        "maxTokens": 100,
        "temperature": 0.2,
    }
    # The provider's id of its answer, for telling one attempt from another in its logs and in ours.
    assert {key: vars(completed)[key] for key in ("model", "textLength", "stopReason", "requestId")} == {
        "model": MODEL,
        "textLength": 5,
        "stopReason": "end_turn",
        "requestId": "resp_played_1",
    }
    assert {key: vars(structured)[key] for key in ("model", "items", "stopReason", "requestId")} == {
        "model": MODEL,
        "items": 1,
        "stopReason": "end_turn",
        "requestId": "resp_played_2",
    }
    assert {key: vars(unread)[key] for key in ("model", "textLength", "stopReason")} == {
        "model": MODEL,
        "textLength": 12,
        "stopReason": "end_turn",
    }


# ── failures ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("status", "word", "asked"),
    [
        (408, "DEADLINE_EXCEEDED", 3),
        (429, "RESOURCE_EXHAUSTED", 3),
        (500, "INTERNAL", 3),
        (502, "UNAVAILABLE", 3),
        (503, "UNAVAILABLE", 3),
        (504, "DEADLINE_EXCEEDED", 3),
        (400, "INVALID_ARGUMENT", 1),
        (401, "UNAUTHENTICATED", 1),
        (402, "FAILED_PRECONDITION", 1),
        (403, "PERMISSION_DENIED", 1),
        (404, "NOT_FOUND", 1),
        (409, "ABORTED", 1),
        (422, "INVALID_ARGUMENT", 1),
        (501, "UNIMPLEMENTED", 1),
    ],
)
def test_a_refused_generation_is_a_provider_status_error_with_the_librarys_failure_as_its_cause(status: int, word: str, asked: int) -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(*[google_error(status, word, "what the provider said")] * asked)
            with pytest.raises(ProviderStatusError) as failed:
                await hurried(driver(played).generate_text("p", 100, 0))
            cause = failed.value.__cause__
            assert isinstance(cause, errors.APIError)
            # What the library said of it, with the status, Google's word for it and the provider's own words in it.
            assert (failed.value.status, str(failed.value)) == (status, str(cause))
            assert str(failed.value).startswith(f"{status} {word}. ")
            assert "what the provider said" in str(failed.value)
            # The tries are this driver's choice of three: a refusal that asking again may mend is asked three times
            # in all, and any other once.
            assert played.generations == [asked_of("p", 100, temperature=0)] * asked

    run(scenario())


def test_left_to_itself_the_library_asks_once_whatever_the_refusal() -> None:
    # Google's own page says its library asks again four times. Read and run, it does not ask again at all.
    async def scenario() -> None:
        async with Google() as played:
            played.script(google_error(503, "UNAVAILABLE", "the provider is overloaded"))
            async with left_to_itself(vertexai=False, base_url=played.origin) as library:
                with pytest.raises(errors.ServerError):
                    await asked_plainly(library.aio.models)
            assert len(played.generating) == 1

    run(scenario())


def test_a_refusal_followed_by_an_answer_is_an_answer() -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(google_error(429, "RESOURCE_EXHAUSTED", "the project is over its rate"), generated(array()))
            assert (await hurried(driver(played).generate_structured("p", 100, 0, ELEMENT))).items == []
            assert len(played.generations) == 2

    run(scenario())


def test_the_waits_before_asking_again_are_the_ones_this_driver_states_and_a_provider_that_says_how_long_to_wait_is_not_heard() -> None:
    # A second and up to a second more, then two seconds and up to a second more.
    async def scenario() -> None:
        async with Google() as played:
            told = saying(
                {"error": {"code": 429, "message": "slow down", "status": "RESOURCE_EXHAUSTED"}}, status=429, headers={"retry-after": "30"}
            )
            played.script(
                google_error(503, "UNAVAILABLE", "overloaded"),
                google_error(500, "INTERNAL", "failed"),
                generated("first"),
                told,
                generated("second"),
            )
            client = driver(played)
            assert (await hurried(client.generate_text("p", 100, 0))).text == "first"
            assert (await hurried(client.generate_text("p", 100, 0))).text == "second"
            at = [asked.at for asked in played.generating]
            first, second, unheard = at[1] - at[0], at[2] - at[1], at[4] - at[3]
            # Each is held from below. The loop's clock is moved a quarter of a second at a time here, however long
            # a step really takes, so from above only a wait of the wrong size is refused.
            assert 1.0 <= first < 2.5, first
            assert 2.0 <= second < 3.5, second
            # The library reads no `retry-after`: the provider said thirty seconds.
            assert 1.0 <= unheard < 2.5, unheard

    run(scenario())


def test_a_connection_that_ends_unanswered_is_not_asked_again_and_is_passed_on_as_httpx_reports_it() -> None:
    # A generation whose connection ends may have been made, and billed: the library's rule asks again for a
    # connection that was never made and for a refusal, and for nothing else.
    async def scenario() -> None:
        async with Google() as played:
            played.script(HANG_UP)
            with pytest.raises(httpx.RemoteProtocolError) as ended:
                await hurried(driver(played).generate_text("p", 100, 0))
            # It carries no status: it is the HTTP library's failure, and none of those the interface declares.
            assert not hasattr(ended.value, "status")
            assert len(played.generations) == 1

    run(scenario())


def test_a_provider_that_cannot_be_reached_is_tried_three_times_and_then_passed_on_as_httpx_reports_it() -> None:
    async def scenario() -> None:
        async with Google() as played:
            gone = GoogleInferenceClient(api_key=KEY, model=MODEL, base_url=played.origin, facts=PLAIN)
        began = asyncio.get_running_loop().time()
        with pytest.raises(httpx.ConnectError):
            await hurried(gone.generate_text("p", 100, 0))
        # The library's two pauses: nothing was sent, so nothing is asked for twice.
        assert 3.0 <= asyncio.get_running_loop().time() - began < 6.0

    run(scenario())


def test_a_generation_that_takes_an_hour_is_neither_given_up_nor_asked_a_second_time() -> None:
    # No bound is stated on the wait for an answer: a generation ends when it is answered, or when its caller cancels it.
    async def scenario() -> None:
        async with Google() as played:
            played.script(HOLD)
            call = asyncio.ensure_future(driver(played).generate_text("p", 100, 0))
            await soon(played.arrived("POST", GENERATION))
            await pass_time(3600, step=30)
            assert not call.done()
            assert len(played.generating) == 1
            played.release(saying({"candidates": [candidate(said(text_part("at last")))], "usageMetadata": counted(10, 5)}))
            assert (await soon(call)).text == "at last"
            assert len(played.generating) == 1

    run(scenario())


# ── cancelling ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
def test_cancelling_a_generation_ends_its_task_cancelled_and_closes_the_connection(structured: bool) -> None:
    async def scenario() -> None:
        async with Google() as played:
            played.script(HOLD)
            call = asyncio.ensure_future(generation(driver(played), structured))
            await soon(played.arrived("POST", GENERATION))
            await settle()
            assert not call.done()
            call.cancel()
            # The cancellation reaches the caller as it is: the library has no abort of its own to report in its place.
            with pytest.raises(asyncio.CancelledError):
                await call
            assert call.cancelled()
            # The provider sees the request torn down, and the library does not ask again for a caller that left.
            await soon(played.closed_by_client.wait())
            await settle()
            assert len(played.generating) == 1

    run(scenario())


# ── the extra ───────────────────────────────────────────────────────────

# The modules of Google's libraries that a program has imported: `google-genai`, and what of Google's it brings.
LOADED = 'sorted(name for name in sys.modules if name.split(".")[0] == "google")'

FACTS = """CatalogueFacts(
    limit=CatalogueLimit(context=1, input=None, output=1),
    reasoning=False,
    reasoning_options=None,
    status=None,
    structured_output=None,
    temperature=None,
)"""

ASKING_FOR_ANOTHER = f"""
import sys
import semiont_inference
from semiont_inference.factory import create_inference_client

ollama = create_inference_client(provider="ollama", model="llama3", base_url="http://127.0.0.1:1", api_key=None)
print(ollama.provider, {LOADED}, "semiont_inference.google" in sys.modules)
"""

ASKING_FOR_GOOGLE = f"""
import sys
from semiont_inference.catalogue import CatalogueFacts, CatalogueLimit

facts = {FACTS}
before = {LOADED}
from semiont_inference.google import GoogleInferenceClient

client = GoogleInferenceClient(api_key="k", model="gemini-x", base_url="http://127.0.0.1:1", facts=facts)
print(before, client.provider, "google.genai" in sys.modules, "semiont_inference.google" in sys.modules)
"""

WITHOUT_GOOGLES_LIBRARY = """
import importlib.abc
import sys


class NotInstalled(importlib.abc.MetaPathFinder):
    # As an interpreter has it where {missing!r}, and what is under it, is not installed.
    def find_spec(self, name, path=None, target=None):
        if name == {missing!r} or name.startswith({missing!r} + "."):
            raise ModuleNotFoundError(f"No module named {{name!r}}", name=name)


sys.meta_path.insert(0, NotInstalled())
from semiont_inference.factory import create_inference_client

try:
    import semiont_inference.google
except ModuleNotFoundError as missing:
    cause = missing.__cause__
    print(type(missing).__name__, "|", missing.name, "|", None if cause is None else cause.name, "|", missing)
print(create_inference_client(provider="ollama", model="llama3", base_url="http://127.0.0.1:1", api_key=None).provider)
"""


def alone(program: str) -> str:
    """What `program` printed, run by an interpreter of its own, from the directory of these tests."""
    ran = subprocess.run([sys.executable, "-c", program], capture_output=True, text=True, check=False, cwd=PACKAGE / "tests")
    assert ran.returncode == 0, ran.stderr
    return ran.stdout


def test_the_package_and_another_providers_client_import_no_part_of_googles_library() -> None:
    assert alone(ASKING_FOR_ANOTHER) == "ollama [] False\n"


def test_asking_for_the_google_driver_is_what_imports_googles_library_and_stating_a_models_facts_does_not() -> None:
    assert alone(ASKING_FOR_GOOGLE) == "[] google True True\n"


@pytest.mark.parametrize("missing", ["google.genai", "google"], ids=["the library alone", "everything of Google's"])
def test_without_googles_library_its_driver_fails_naming_the_extra_and_an_ollama_client_is_made(missing: str) -> None:
    said_of_it = (
        "The Google driver needs Google's `google-genai` library, which is not installed. "
        "It comes with the extra: install `semiont-inference[google]`."
    )
    assert alone(WITHOUT_GOOGLES_LIBRARY.format(missing=missing)).splitlines() == [
        # Its cause is the interpreter's own failure, which names what it did not find.
        f"ModuleNotFoundError | google.genai | {missing} | {said_of_it}",
        "ollama",
    ]


def test_a_module_googles_library_itself_lacks_is_another_failure_and_is_left_as_it_is() -> None:
    # The library is there, and something it needs is not: the extra would not mend that, and is not named.
    assert alone(WITHOUT_GOOGLES_LIBRARY.format(missing="tenacity")).splitlines() == [
        "ModuleNotFoundError | tenacity | None | No module named 'tenacity'",
        "ollama",
    ]


# ── telemetry ───────────────────────────────────────────────────────────

# Generations of the driver that end each way, in a process of its own: a process has one meter provider, and
# tests/test_telemetry.py installs this one's. What an in-memory reader collected is printed as JSON.
TRAFFIC = """
import asyncio
import json

from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from provider import HOLD
from provider_google import Generated, Google, candidate, counted, generated, google_error, said, text_part

from semiont_inference.catalogue import CatalogueFacts, CatalogueLimit
from semiont_inference.google import GoogleInferenceClient
from semiont_inference.interface import ProviderStatusError, ProviderWithheldError, StructuredReadError

MODEL = "telemetry-gemini"
FACTS = CatalogueFacts(
    limit=CatalogueLimit(context=1_048_576, input=None, output=65_536),
    reasoning=False,
    reasoning_options=None,
    status=None,
    structured_output=True,
    temperature=True,
)
ELEMENT = {"type": "object", "properties": {"exact": {"type": "string"}}, "required": ["exact"]}


async def fails(call, kind):
    try:
        await call
    except kind:
        return
    raise AssertionError(f"{kind.__name__} was not raised")


async def traffic():
    async with Google() as played:
        played.script(
            generated("hello", usage=counted(4127, 500, 71)),
            generated("not an array", usage=counted(10, 5)),
            # Nothing in it, and still counted by the provider: the budget went on thinking.
            Generated(candidates=[candidate({"role": "model"}, finish_reason="MAX_TOKENS")], usage=counted(7, None, 3)),
            # Withheld, and still counted.
            Generated(candidates=[candidate(None, finish_reason="SAFETY")], usage=counted(9, 2)),
            # Its provider reports no tokens: it is counted as a call, and adds none.
            Generated(candidates=[candidate(said(text_part("hello")))], usage=None),
            google_error(400, "INVALID_ARGUMENT", "the request is not valid"),
            HOLD,
        )
        gemini = GoogleInferenceClient(api_key="k", model=MODEL, base_url=played.origin, facts=FACTS)
        # Learning a model's limits is no generation, and is not counted as one.
        await gemini.limits()
        await gemini.generate_text("p", 100, 0)
        await fails(gemini.generate_structured("p", 100, 0, ELEMENT), StructuredReadError)
        await fails(gemini.generate_text("p", 100, 0), StructuredReadError)
        await fails(gemini.generate_text("p", 100, 0), ProviderWithheldError)
        await gemini.generate_text("p", 100, 0)
        await fails(gemini.generate_text("p", 100, 0), ProviderStatusError)
        cancelled = asyncio.ensure_future(gemini.generate_text("p", 100, 0))
        await asyncio.wait_for(played.arrived("POST", Google.generation(MODEL), 7), 5)
        cancelled.cancel()
        await fails(cancelled, asyncio.CancelledError)


reader = InMemoryMetricReader()
metrics.set_meter_provider(MeterProvider(metric_readers=[reader]))
asyncio.run(traffic())
print(
    json.dumps(
        [
            {
                "name": metric.name,
                "unit": metric.unit,
                "instrument": type(metric.data).__name__,
                "monotonic": getattr(metric.data, "is_monotonic", None),
                "attributes": dict(point.attributes),
                "value": getattr(point, "value", None),
                "count": getattr(point, "count", None),
            }
            for resource in reader.get_metrics_data().resource_metrics
            for scope in resource.scope_metrics
            for metric in scope.metrics
            for point in metric.data.data_points
        ]
    )
)
"""
PREFIX = "semiont.inference."


def test_the_driver_records_the_three_the_table_lists_by_the_tables_keys_under_its_own_providers_name() -> None:
    # Its provider's name is not among the values the table lists: the protocol's list of providers is closed, and gains
    # `google` with the service that makes this driver. So its points are held to the table's keys, and counted.
    points = _POINTS.validate_json(alone(TRAFFIC))
    rows = {text(row["name"], "a name"): row for row in objects(read(SPEC / "service-telemetry/telemetry.json")["metrics"], "the metrics")}
    listed = {name: row for name, row in rows.items() if name.startswith(PREFIX)}
    assert listed, "the table lists no inference metric: this test reads nothing"
    assert {text(point["name"], "a name") for point in points if text(point["name"], "a name").startswith(PREFIX)} == set(listed)

    calls: dict[JsonValue, JsonValue] = {}
    tokens: dict[JsonValue, JsonValue] = {}
    timed: dict[JsonValue, JsonValue] = {}
    for name, row in listed.items():
        keys = {text(attribute["key"], "a key") for attribute in objects(row["attributes"], "the attributes")}
        recorded = [point for point in points if point["name"] == name]
        assert recorded, f"no {name} was recorded"
        for point in recorded:
            attributes = thing(point["attributes"], "the attributes")
            assert set(attributes) == keys, f"{name} carries {set(attributes)}; the table lists {keys}"
            assert (attributes["inference.provider"], attributes["inference.model"]) == ("google", "telemetry-gemini")
            match text(row["instrument"], "an instrument"), name.removeprefix(PREFIX):
                case "counter", "calls":
                    assert (point["instrument"], point["monotonic"]) == ("Sum", True)
                    calls[attributes["inference.outcome"]] = point["value"]
                case "counter", "tokens":
                    assert (point["instrument"], point["monotonic"]) == ("Sum", True)
                    tokens[attributes["inference.direction"]] = point["value"]
                case "histogram", "duration":
                    assert (point["instrument"], point["unit"]) == ("Histogram", "ms")
                    timed[attributes["inference.outcome"]] = point["count"]
                case other:
                    raise AssertionError(f"{other} is a row this test does not know how to hold")

    # Two answered; five not: unreadable, empty, withheld, refused, cancelled.
    assert calls == {"success": 2, "error": 5}
    # What the provider counted, the thoughts with the answer, the failing ones too, and nothing for a call it counted none of.
    assert tokens == {"input": 4127 + 10 + 7 + 9, "output": 500 + 71 + 5 + 3 + 2}
    assert timed == calls
