"""The Together driver, against a Together API this test plays over HTTP.

The driver reaches the provider through Together's own library, and the
library is not replaced or patched: it sends real requests to the stand-in,
which answers the model list from what a test stated and each generation from
what a test scripted. What arrives is held exactly, the headers too.

Together's API states a model's context window and nothing else of it, so a
driver is handed the rest of its model's facts by whoever makes it. Each case
here states the facts it rests on. One test reads a real catalogue file, and
holds the driver to every entry of Together's in it.

Some of what the library does it does once in a process, when it is imported
or first asked: it reads its logging switch, and it looks for a coding agent.
What is held of those is run in an interpreter of its own, which is this file
run as a program (`alone`).
"""

import asyncio
import dataclasses
import logging
import os
import re
import subprocess
import sys
from collections.abc import Callable, Coroutine
from typing import Final

import pytest
import together
from aio import hurried, pass_time, run, settle, soon
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import Histogram, HistogramDataPoint, InMemoryMetricReader, NumberDataPoint, Sum
from provider import HANG_UP, HOLD, Answer, saying
from provider_together import Completed, Together, choice, completed, counted, listed, model_list, together_error, whole
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
from semiont_inference.interface import (
    InferenceClient,
    InferenceLimits,
    InferenceResponse,
    ProviderStatusError,
    StructuredReadError,
    StructuredResponse,
    TokenUsage,
)
from semiont_inference.together import TogetherInferenceClient

KEY = "key-played"
MODEL = "acme/Model-X"
CATALOGUE = PACKAGE / "tests/catalogue/model-catalogue.json"
COUNTED = TokenUsage(input_tokens=10, output_tokens=5)
PROMPT = "A prompt nobody else is to read."

_JSON = TypeAdapter[JsonValue](JsonValue)

# From least to most, as the driver's design orders them. A catalogue does not always list them so.
LEAST_FIRST = ("none", "minimal", "low", "medium", "high", "xhigh", "max")

ELEMENT: JsonObject = {"type": "object", "properties": {"exact": {"type": "string"}}, "required": ["exact"], "additionalProperties": False}
# An element two of whose properties are optional, as each of the worker's own schemas is.
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

# What turns a model's reasoning off, for one whose facts say it can be.
OFF: JsonObject = {"reasoning": {"enabled": False}}

# The window the played list states for every model of a real catalogue: above what some of them write at most, by the
# catalogue, and below what others do.
LISTED = 200_000


def efforts(*values: ReasoningEffort) -> tuple[ReasoningOption, ...]:
    """Reasoning set by an effort, of those named."""
    return (EffortOption(type="effort", values=values),)


# A model that does not reason. It holds a reply to a schema, and takes a temperature. The catalogue's window
# is not the one any list here states, and its ceiling on what is written is a number the provider states nowhere.
PLAIN = CatalogueFacts(
    limit=CatalogueLimit(context=131_072, input=None, output=16_384),
    reasoning=False,
    reasoning_options=None,
    status=None,
    structured_output=True,
    temperature=True,
)
# A model whose reasoning is turned on or off.
HYBRID = dataclasses.replace(PLAIN, reasoning=True, reasoning_options=(ToggleOption(type="toggle"),))
# A model whose reasoning is set by an effort, and cannot be turned off.
EFFORT = dataclasses.replace(PLAIN, reasoning=True, reasoning_options=efforts("low", "medium", "high"))


def driver(played: Together, facts: CatalogueFacts = PLAIN, model: str = MODEL) -> TogetherInferenceClient:
    return TogetherInferenceClient(api_key=KEY, model=model, base_url=played.base_url, facts=facts)


def ceilings(context_tokens: int, max_output_tokens: int, accepts_temperature: bool | None = True) -> InferenceLimits:
    """A model's window and the most it writes, as a Together model's are stated. Together states no rate."""
    return InferenceLimits(
        context_tokens=context_tokens,
        max_output_tokens=max_output_tokens,
        output_tokens_per_hour=None,
        accepts_temperature=accepts_temperature,
    )


def said_to(model: str, prompt: str, max_tokens: int, **rest: JsonValue) -> JsonObject:
    """A request for plain text, as it arrives: the model, the prompt as the one message of a user, the budget, and what `rest` states."""
    return {"model": model, "messages": [{"role": "user", "content": prompt}], "max_tokens": max_tokens, **rest}


def held_to(element: JsonObject) -> JsonObject:
    """What a structured request carries beside the rest: the schema as its caller wrote it, an array of it at the root, under a name."""
    return {"type": "json_schema", "json_schema": {"name": "elements", "schema": {"type": "array", "items": element}}}


def written(*items: JsonValue) -> str:
    """A reply's text, as a model held to an array writes it."""
    return _JSON.dump_json([*items]).decode()


async def generation(client: TogetherInferenceClient, structured: bool) -> InferenceResponse | StructuredResponse:
    if structured:
        return await client.generate_structured("p", 100, 0, ELEMENT)
    return await client.generate_text("p", 100, 0)


def ours(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_inference"]


def at(level: int, caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in ours(caplog) if record.levelno == level]


# ── what it is ──────────────────────────────────────────────────────────


def test_it_is_a_client_of_the_provider_together_and_says_what_a_worker_asks_of_any_client() -> None:
    client: InferenceClient = TogetherInferenceClient(api_key=KEY, model=MODEL, base_url="http://127.0.0.1:1/v1", facts=PLAIN)
    assert (client.provider, client.model_id, client.max_concurrency, client.verify_detection_yield) == ("together", MODEL, 4, True)


# ── limits ──────────────────────────────────────────────────────────────


def test_it_learns_the_models_window_from_the_model_list_once_and_keeps_it(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Together(
            listed("acme/Model-A", context_length=8_192),
            listed(MODEL, context_length=32_768, display_name="Model X", organization="Acme"),
            listed("acme/embedder", type="embedding"),
        ) as played:
            client = driver(played)
            # The window is the provider's own number, and not the catalogue's. The provider states no ceiling
            # on what is written: that one is the catalogue's.
            assert await client.limits() == ceilings(32_768, 16_384)
            assert await client.limits() == ceilings(32_768, 16_384)
            # The whole list, which is the one thing the API can be asked: there is no request for one model.
            assert [f"{asked.method} {asked.path}" for asked in played.asked] == ["GET /v1/models"]

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    assert ours(caplog) == []


def test_the_models_entry_is_found_among_whatever_else_the_list_holds() -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.models = saying([7, MODEL, None, [MODEL], {"id": 5}, {"context_length": 1}, listed(MODEL, context_length=4_096)])
            assert await driver(played).limits() == ceilings(4_096, 4_096)

    run(scenario())


@pytest.mark.parametrize(
    ("context", "output", "stated", "said"),
    [
        (131_072, 16_384, {"context_length": 32_768}, ceilings(32_768, 16_384)),
        (131_072, 16_384, {"context_length": 16_384}, ceilings(16_384, 16_384)),
        (131_072, 16_384, {"context_length": 4_096}, ceilings(4_096, 4_096)),
        (131_072, 131_072, {"context_length": 32_768}, ceilings(32_768, 32_768)),
        (131_072, 16_384, {}, ceilings(131_072, 16_384)),
        (8_192, 16_384, {}, ceilings(8_192, 8_192)),
    ],
    ids=[
        "a window listed above the catalogue's ceiling",
        "a window listed at the catalogue's ceiling",
        "a window listed below the catalogue's ceiling",
        "a window listed below a catalogue's window that is also its ceiling",
        "no window listed",
        "no window listed, and a catalogue whose ceiling is above its own window",
    ],
)
def test_the_most_a_model_writes_is_the_catalogues_word_and_is_never_stated_above_its_window(
    context: int, output: int, stated: JsonObject, said: InferenceLimits
) -> None:
    # Together's API states no ceiling on what a model writes. The catalogue's numbers are not checked against
    # the provider's, or against each other, and a model writes no more than its window holds.
    async def scenario() -> None:
        async with Together(listed(MODEL, **stated)) as played:
            facts = dataclasses.replace(PLAIN, limit=CatalogueLimit(context=context, input=None, output=output))
            assert await driver(played, facts).limits() == said

    run(scenario())


@pytest.mark.parametrize("temperature", [True, False, None], ids=["taken", "refused", "not stated"])
def test_whether_the_model_takes_a_temperature_is_said_on_its_limits_as_its_facts_say_it(temperature: bool | None) -> None:
    async def scenario() -> None:
        async with Together(listed(MODEL, context_length=32_768)) as played:
            client = driver(played, dataclasses.replace(PLAIN, temperature=temperature))
            assert await client.limits() == ceilings(32_768, 16_384, temperature)

    run(scenario())


@pytest.mark.parametrize(
    "stated",
    [
        {},
        {"context_length": None},
        {"context_length": 0},
        {"context_length": -1},
        {"context_length": "32768"},
        {"context_length": True},
        {"context_length": 32_768.5},
    ],
    ids=["none", "null", "zero", "below zero", "text", "a boolean", "not whole"],
)
def test_where_the_list_states_no_context_length_the_window_is_the_catalogues_and_the_driver_says_whose_word_it_is(
    stated: JsonObject, caplog: pytest.LogCaptureFixture
) -> None:
    # Together's own catalogue page shows serverless chat models with no context length at all.
    async def scenario() -> None:
        async with Together(listed("acme/Model-A", context_length=8_192), listed(MODEL, **stated)) as played:
            client = driver(played)
            # Both are then the catalogue's word: its window, and its ceiling on what is written.
            assert await client.limits() == ceilings(131_072, 16_384)
            assert await client.limits() == ceilings(131_072, 16_384)
            assert len(played.lists) == 1

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (warned,) = ours(caplog)
    assert (warned.levelname, warned.getMessage()) == (
        "WARNING",
        "Together's model list states no context length for the model: its window is the model catalogue's word",
    )
    assert {key: vars(warned)[key] for key in ("model", "contextTokens")} == {"model": MODEL, "contextTokens": 131_072}


def test_a_model_the_list_does_not_have_fails_the_discovery_which_is_not_kept() -> None:
    # Together moves a model id to its successor on three days' notice, and withdraws one in two weeks.
    async def scenario() -> None:
        async with Together(listed("acme/Model-A", context_length=8_192), listed("acme/model-x", context_length=4_096)) as played:
            client = driver(played)
            with pytest.raises(RuntimeError, match=re.escape(f"Together's model list does not have '{MODEL}'")) as absent:
                await client.limits()
            assert type(absent.value) is RuntimeError
            assert not hasattr(absent.value, "status")

            # The catalogue's window is not answered in its place: the model is listed, and the next call asks again.
            played.models = model_list(listed(MODEL, context_length=32_768))
            assert await client.limits() == ceilings(32_768, 16_384)
            assert len(played.lists) == 2

    run(scenario())


@pytest.mark.parametrize(
    "said",
    [
        Answer(headers={"content-type": "text/html"}, body=b"<html>a gateway's page</html>"),
        saying({"object": "list", "data": [listed(MODEL, context_length=32_768)]}),
        saying(MODEL),
    ],
    ids=["not JSON", "an object that holds the list", "text"],
)
def test_a_model_list_that_is_not_a_json_array_fails_the_discovery(said: Answer) -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.models = said
            with pytest.raises(RuntimeError, match=re.escape("Together's model list is not a JSON array")) as unread:
                await driver(played).limits()
            assert type(unread.value) is RuntimeError
            assert len(played.lists) == 1

    run(scenario())


@pytest.mark.parametrize(("status", "asked"), [(429, 3), (500, 3), (503, 3), (401, 1), (403, 1), (404, 1)])
def test_limits_it_cannot_learn_are_a_plain_error_with_no_status_and_are_not_kept(status: int, asked: int) -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.models = together_error(status, kind="error", code=None, message="what the provider said")
            client = driver(played)
            with pytest.raises(
                RuntimeError, match=re.escape(f"Failed to discover model limits for '{MODEL}' from Together's model list")
            ) as refused:
                await client.limits()
            # A discovery that fails is not a refused generation: nothing about it is classified by a status.
            assert type(refused.value) is RuntimeError
            assert not hasattr(refused.value, "status")
            cause = refused.value.__cause__
            assert isinstance(cause, together.APIStatusError)
            assert cause.status_code == status
            # The retries are this driver's choice of two: a refusal the library asks again for is asked three times in all.
            assert len(played.lists) == asked

            # The provider recovers, and the next call asks again.
            played.models = model_list(listed(MODEL, context_length=32_768))
            assert await client.limits() == ceilings(32_768, 16_384)
            assert len(played.lists) == asked + 1

    run(scenario())


def test_callers_that_ask_at_once_share_one_request_for_the_limits() -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.models = HOLD
            client = driver(played)
            first, second = asyncio.ensure_future(client.limits()), asyncio.ensure_future(client.limits())
            await soon(played.arrived("GET", "/v1/models"))
            await settle()
            assert played.holding == 1
            played.release(model_list(listed(MODEL, context_length=4_096)))
            assert list(await soon(asyncio.gather(first, second))) == [ceilings(4_096, 4_096), ceilings(4_096, 4_096)]
            assert len(played.lists) == 1

    run(scenario())


def test_a_caller_cancelled_while_the_limits_are_being_learned_leaves_at_once_and_the_others_still_get_them() -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.models = HOLD
            client = driver(played)
            leaving, staying = asyncio.ensure_future(client.limits()), asyncio.ensure_future(client.limits())
            await soon(played.arrived("GET", "/v1/models"))
            leaving.cancel()
            with pytest.raises(asyncio.CancelledError):
                await leaving
            assert leaving.cancelled()
            # What is learned once for every caller is not one caller's to end: the request is still open.
            await settle()
            assert not played.closed_by_client.is_set()
            played.release(model_list(listed(MODEL, context_length=4_096)))
            assert await soon(staying) == ceilings(4_096, 4_096)
            assert len(played.lists) == 1

    run(scenario())


def test_the_request_for_the_model_list_waits_a_minute_for_its_answer_and_is_asked_three_times_in_all() -> None:
    # A list is answered from what the provider holds, without running a model, and asking for it again costs nothing.
    async def scenario() -> None:
        async with Together() as played:
            played.models = HOLD
            asking = asyncio.ensure_future(driver(played).limits())
            await soon(played.arrived("GET", "/v1/models"))
            await pass_time(55, step=5)
            assert not asking.done()
            assert len(played.lists) == 1
            await pass_time(200, step=5)
            with pytest.raises(RuntimeError, match=re.escape(f"Failed to discover model limits for '{MODEL}'")) as gave_up:
                await soon(asking)
            assert isinstance(gave_up.value.__cause__, together.APITimeoutError)
            assert len(played.lists) == 3

    run(scenario())


def test_a_generation_asks_nothing_of_the_model_list_and_the_limits_ask_for_no_generation() -> None:
    # What a generation needs of its model is in the facts the driver was handed.
    async def scenario() -> None:
        async with Together(listed(MODEL, context_length=32_768)) as played:
            played.script(completed("ok"), completed(written()))
            client = driver(played)
            await client.generate_text("p", 100, 0)
            await client.generate_structured("p", 100, 0, ELEMENT)
            assert [f"{asked.method} {asked.path}" for asked in played.asked] == ["POST /v1/chat/completions"] * 2
            await client.limits()
            assert len(played.completions) == 2

    run(scenario())


# ── the request ─────────────────────────────────────────────────────────


def test_plain_text_is_one_request_of_exactly_these_members() -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.script(completed("The Loire."))
            answer = await driver(played, HYBRID).generate_text("Name one river of France.", 200, 0.3)
            assert answer == InferenceResponse(text="The Loire.", stop_reason="end_turn", usage=COUNTED)
            # The model is told not to reason. No schema, no stream, no tool, no stop sequence, nothing that labels the request.
            assert played.generations == [said_to(MODEL, "Name one river of France.", 200, temperature=0.3, **OFF)]

    run(scenario())


def test_a_structured_generation_sends_the_callers_schema_as_written_with_an_array_at_its_root_and_reads_the_array() -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.script(
                completed(
                    written(
                        {"exact": "Paris", "entityType": "Place", "suffix": " is"},
                        {"exact": 'the "best" café', "entityType": "Place", "prefix": "at ", "suffix": ""},
                    )
                )
            )
            answer = await driver(played, HYBRID).generate_structured("Extract places", 1000, 0, PERSON)
            # The optional properties stay optional, and `strict`, whose subset of JSON Schema Together publishes nowhere, is not said.
            assert played.generations == [
                {**said_to(MODEL, "Extract places", 1000, temperature=0, **OFF), "response_format": held_to(PERSON)}
            ]
            # An element is what the model wrote: a property it left out is left out, and one it wrote empty is empty.
            assert answer == StructuredResponse(
                items=[
                    {"exact": "Paris", "entityType": "Place", "suffix": " is"},
                    {"exact": 'the "best" café', "entityType": "Place", "prefix": "at ", "suffix": ""},
                ],
                stop_reason="end_turn",
                usage=COUNTED,
            )

    run(scenario())


@pytest.mark.parametrize(
    ("options", "stated"),
    [
        ((ToggleOption(type="toggle"),), OFF),
        ((ToggleOption(type="toggle"), EffortOption(type="effort", values=("low", "high", "max"))), OFF),
        ((EffortOption(type="effort", values=("none", "low")), ToggleOption(type="toggle")), OFF),
        ((BudgetTokensOption(type="budget_tokens", min=0, max=24_576), ToggleOption(type="toggle")), OFF),
        (efforts("low", "medium", "high"), {"reasoning_effort": "low"}),
        (efforts("high", "max"), {"reasoning_effort": "high"}),
        (efforts("max", "xhigh", "high", "medium", "low", "none"), {"reasoning_effort": "none"}),
        (efforts("low", "minimal"), {"reasoning_effort": "minimal"}),
        (efforts("max", "xhigh"), {"reasoning_effort": "xhigh"}),
        (efforts("max"), {"reasoning_effort": "max"}),
        (
            (EffortOption(type="effort", values=("high",)), EffortOption(type="effort", values=("xhigh", "medium"))),
            {"reasoning_effort": "medium"},
        ),
        (
            (BudgetTokensOption(type="budget_tokens", min=0, max=24_576), EffortOption(type="effort", values=("high", "low"))),
            {"reasoning_effort": "low"},
        ),
        ((BudgetTokensOption(type="budget_tokens", min=0, max=24_576),), {}),
        (efforts(), {}),
        ((), {}),
        (None, {}),
    ],
    ids=[
        "a toggle alone",
        "a toggle beside efforts",
        "a toggle listed after efforts",
        "a toggle beside a budget of tokens",
        "efforts listed from least to most",
        "efforts that begin at high",
        "efforts listed from most to least, none among them",
        "minimal listed after low",
        "xhigh after max",
        "max alone",
        "two lists of efforts",
        "efforts beside a budget of tokens",
        "a budget of tokens alone",
        "an effort of no values",
        "no way stated",
        "a model that does not reason",
    ],
)
def test_the_least_thinking_is_asked_for_by_the_kind_of_option_the_facts_name_on_either_kind_of_generation(
    options: tuple[ReasoningOption, ...] | None, stated: JsonObject
) -> None:
    # A toggle is turned off, and nothing is less than off. With no toggle, the least of the efforts named. A budget of
    # tokens has no parameter at Together, and a model with no way stated is sent no setting.
    async def scenario() -> None:
        async with Together() as played:
            played.script(completed("ok"), completed(written()))
            client = driver(played, dataclasses.replace(PLAIN, reasoning=options is not None, reasoning_options=options))
            await client.generate_text("p", 100, 0)
            await client.generate_structured("p", 100, 0, ELEMENT)
            assert played.generations == [
                said_to(MODEL, "p", 100, temperature=0, **stated),
                {**said_to(MODEL, "p", 100, temperature=0, **stated), "response_format": held_to(ELEMENT)},
            ]

    run(scenario())


@pytest.mark.parametrize(
    ("temperature", "options"),
    [
        (True, None),
        (True, (ToggleOption(type="toggle"),)),
        (True, efforts("low", "high")),
        (False, None),
        (False, efforts("low", "high")),
        (None, None),
        (None, (ToggleOption(type="toggle"),)),
    ],
    ids=[
        "taken, by a model that does not reason",
        "taken, by a model told not to reason",
        "taken, by a model that must reason",
        "refused, by a model that does not reason",
        "refused, by a model that must reason",
        "not stated, of a model that does not reason",
        "not stated, of a model told not to reason",
    ],
)
def test_a_temperature_is_sent_only_where_the_facts_say_it_is_taken_and_the_limits_say_the_same(
    temperature: bool | None, options: tuple[ReasoningOption, ...] | None
) -> None:
    async def scenario() -> None:
        async with Together(listed(MODEL, context_length=32_768)) as played:
            played.script(completed("ok"), completed(written()))
            client = driver(played, dataclasses.replace(PLAIN, temperature=temperature, reasoning_options=options))
            await client.generate_text("p", 100, 0.3)
            await client.generate_structured("p", 100, 0.3, ELEMENT)
            sent = temperature is True
            assert [body.get("temperature") for body in played.generations] == ([0.3, 0.3] if sent else [None, None])
            assert ["temperature" in body for body in played.generations] == [sent, sent]
            # What the limits say of a temperature is what the requests do with one.
            assert (await client.limits()).accepts_temperature is temperature

    run(scenario())


def test_every_together_entry_of_a_real_catalogue_is_asked_as_the_entry_says() -> None:
    # The facts as a worker gets them: read from a catalogue file, and handed to the driver. What each entry
    # says is read a second time here, from the file as JSON, and by this test's own statement of the order.
    catalogue = read_catalogue(CATALOGUE)
    entries = thing(thing(thing(read(CATALOGUE)["providers"], "the providers")["togetherai"], "togetherai")["models"], "the models")
    assert len(entries) > 20, "the catalogue has few of Together's models: this test reads little"
    asked_by: set[str] = set()
    ceiling_is: set[str] = set()

    async def scenario() -> None:
        async with Together(*(listed(model_id, context_length=LISTED) for model_id in entries)) as played:
            for model_id, stated in entries.items():
                entry = thing(stated, model_id)
                facts = catalogue_facts(catalogue, "together", model_id)
                assert facts is not None, model_id
                options = [] if entry["reasoning_options"] is None else objects(entry["reasoning_options"], "the options")
                named = [effort for option in options if option["type"] == "effort" for effort in strings(option["values"], "the efforts")]
                expected = said_to(model_id, "p", 100)
                if any(option["type"] == "toggle" for option in options):
                    expected.update(OFF)
                    asked_by.add("a toggle")
                elif named:
                    expected["reasoning_effort"] = min(named, key=LEAST_FIRST.index)
                    asked_by.add("an effort")
                else:
                    asked_by.add("nothing")
                takes_temperature = entry["temperature"]
                assert takes_temperature is None or isinstance(takes_temperature, bool)
                if takes_temperature is True:
                    expected["temperature"] = 0.3

                output = thing(entry["limit"], "the limit")["output"]
                assert isinstance(output, int)
                ceiling_is.add("the catalogue's" if output <= LISTED else "the window")

                client = driver(played, facts, model_id)
                # The window is the provider's, whatever the catalogue says of the model, and the most the model
                # writes is the catalogue's unless the window is less.
                assert await client.limits() == ceilings(LISTED, min(output, LISTED), takes_temperature), model_id
                played.script(completed("ok"))
                await client.generate_text("p", 100, 0.3)
                assert played.generations[-1] == expected, model_id

    run(scenario())
    assert asked_by == {"a toggle", "an effort", "nothing"}
    assert ceiling_is == {"the catalogue's", "the window"}


def test_an_element_schema_with_a_keyword_this_package_does_not_know_is_refused_before_any_request() -> None:
    # What Together does with a keyword it was not expected to see is published nowhere.
    async def scenario() -> None:
        async with Together() as played:
            bounded: JsonObject = {"type": "object", "properties": {"exact": {"type": "string", "minLength": 1}}, "required": ["exact"]}
            with pytest.raises(ValueError, match=re.escape("`minLength` is a keyword this package does not rewrite")):
                await driver(played).generate_structured("p", 100, 0, bounded)
            assert played.asked == []

    run(scenario())


# ── what the library does unasked ───────────────────────────────────────

# What the library reads from the environment whatever it is given, each set to what a driver must not send.
UNASKED = {
    "TOGETHER_API_KEY": "key-from-the-environment",
    "TOGETHER_BASE_URL": "http://127.0.0.1:1/v1",
    "TOGETHER_PROJECT_ID": "project-from-the-environment",
    "TOGETHER_CUSTOM_HEADERS": "\n".join(
        [
            "Authorization: Bearer key-custom-from-the-environment",
            "User-Agent: from-the-environment",
            "accept: text/html",
            "X-From-The-Environment: 1",
        ]
    ),
    # The variable a coding agent names itself by, which the library sends to the provider as it is.
    "AI_AGENT": "an-agent-from-the-environment",
}
PROXIES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")

# The headers of a generation: what HTTP itself needs, and the four this driver states.
SENT = {"host", "accept-encoding", "connection", "content-length", "accept", "content-type", "user-agent", "authorization"}
# The library's own mark on a request whose answer is asked for as the provider wrote it. It reads the mark back itself.
MARK = "x-stainless-raw-response"


def alone(scenario: str, **environment: str) -> subprocess.CompletedProcess[str]:
    """Run one of this file's scenarios (`ALONE`) in an interpreter of its own, with `environment` set before anything is imported.

    Whatever this process's environment says to the library or of a coding
    agent is taken out first: the scenario sees what the test states.
    """
    inherited = {name: value for name, value in os.environ.items() if not name.startswith("TOGETHER_") and name != "AI_AGENT"}
    ran = subprocess.run(
        [sys.executable, __file__, scenario], capture_output=True, text=True, check=False, env={**inherited, **environment}
    )
    assert ran.returncode == 0, ran.stderr
    return ran


async def asked_alone() -> JsonValue:
    """One generation asked of the library left to itself, then the model list and both kinds of generation asked of the driver."""
    async with Together(listed(MODEL, context_length=32_768)) as played:
        played.script(completed("ok"), completed("ok"), completed(written()))
        async with together.AsyncTogether(api_key=KEY, base_url=played.base_url, max_retries=0) as library:
            await library.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": "p"}])
        client = driver(played, HYBRID)
        await client.limits()
        await client.generate_text("p", 100, 0)
        await client.generate_structured("p", 100, 0, ELEMENT)
        requests: list[JsonValue] = []
        for asked in played.asked:
            headers: JsonObject = dict(asked.headers)
            requests.append({"request": f"{asked.method} {asked.path}", "headers": headers, "body": asked.body.decode()})
        return {"host": played.origin.removeprefix("http://"), "requests": requests}


@pytest.fixture(scope="module")
def unasked() -> JsonObject:
    """What arrived of `asked_alone`, run with everything the library reads from the environment set."""
    return thing(_JSON.validate_json(alone("asked", **UNASKED).stdout), "what arrived")


def test_a_request_carries_what_this_driver_states_and_nothing_the_library_or_the_environment_would_add(unasked: JsonObject) -> None:
    _, models, *generations = objects(unasked["requests"], "the requests")
    assert [text(asked["request"], "a request") for asked in (models, *generations)] == [
        "GET /v1/models",
        "POST /v1/chat/completions",
        "POST /v1/chat/completions",
    ]
    stated = {
        "host": unasked["host"],
        "accept": "application/json",
        # The library's name and version, and nothing of the machine it runs on or of an agent it runs under.
        "user-agent": f"AsyncTogether/Python {together.__version__}",
        # The key it was given, whatever the environment says.
        "authorization": f"Bearer {KEY}",
        MARK: "raw",
    }
    # A request with no body states no length and no type of one. Nothing says how long a read may take, though this one has a bound.
    listing = thing(models["headers"], "the headers")
    assert set(listing) == (SENT - {"content-length", "content-type"}) | {MARK}
    assert {name: listing[name] for name in stated} == stated
    for asked in generations:
        headers = thing(asked["headers"], "the headers")
        assert set(headers) == SENT | {MARK}
        assert {name: headers[name] for name in (*stated, "content-length", "content-type")} == {
            **stated,
            "content-length": str(len(text(asked["body"], "a body").encode())),
            "content-type": "application/json",
        }


def test_left_to_itself_the_library_sends_what_this_driver_omits(unasked: JsonObject) -> None:
    # This asks the library itself, so a release that changes what it adds on its own fails here and is read again.
    left_to_itself, *_ = objects(unasked["requests"], "the requests")
    assert left_to_itself["request"] == "POST /v1/chat/completions"
    headers = thing(left_to_itself["headers"], "the headers")
    assert set(headers) - SENT == {
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
        # The coding agent it found itself under.
        "x-stainless-agent",
        # What the environment named.
        "x-from-the-environment",
    }
    assert headers["x-stainless-read-timeout"] == "60"
    # The variable's own value, as it was.
    assert headers["x-stainless-agent"] == "an-agent-from-the-environment"
    # A line of the environment's replaced the key it was given, another named the client, and a third said what answer it takes.
    assert (headers["authorization"], headers["user-agent"], headers["accept"]) == (
        "Bearer key-custom-from-the-environment",
        "from-the-environment",
        "text/html",
    )


async def logged_alone() -> JsonValue:
    """One generation asked of the driver, for what the process's own log holds afterwards."""
    async with Together() as played:
        played.script(completed("ok"))
        return (await driver(played).generate_text(PROMPT, 100, 0)).text


def test_the_librarys_logging_switch_is_not_switched_off_and_at_debug_the_prompt_is_in_the_processs_own_log() -> None:
    # `TOGETHER_LOG` is read when the library is imported, and the library has no argument for it. This holds what the
    # driver's module says of it: a release that logs otherwise fails here and is read again.
    switched_on = alone("logged", TOGETHER_LOG="debug")
    assert "Request options" in switched_on.stderr
    assert PROMPT in switched_on.stderr
    # Without the switch the same generation leaves nothing of the request in the log.
    switched_off = alone("logged")
    assert "Request options" not in switched_off.stderr
    assert PROMPT not in switched_off.stderr


def test_the_address_it_was_given_is_the_address_asked_whatever_proxy_and_certificates_the_environment_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        async with Together(listed(MODEL, context_length=32_768)) as played, Together() as proxy:
            for name in PROXIES:
                monkeypatch.setenv(name, proxy.origin)
            for name in ("NO_PROXY", "no_proxy"):
                monkeypatch.delenv(name, raising=False)
            monkeypatch.setenv("SSL_CERT_FILE", "/nowhere/certificates.pem")
            played.script(completed("ok"))
            client = driver(played)
            assert await client.limits() == ceilings(32_768, 16_384)
            assert (await client.generate_text("p", 100, 0)).text == "ok"
            assert proxy.asked == []
            assert (len(played.lists), len(played.completions)) == (1, 1)

    run(scenario())


def test_left_to_itself_the_library_asks_the_proxy_the_environment_names(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with Together() as played, Together() as proxy:
            for name in PROXIES:
                monkeypatch.setenv(name, proxy.origin)
            for name in ("NO_PROXY", "no_proxy"):
                monkeypatch.delenv(name, raising=False)
            async with together.AsyncTogether(api_key=KEY, base_url=played.base_url, max_retries=0) as library:
                with pytest.raises(together.NotFoundError):
                    await library.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": "p"}])
            # The request went to the proxy, which is asked for the whole address, and the provider saw nothing.
            assert played.asked == []
            assert proxy.unscripted == [f"POST {played.base_url}/chat/completions"]
            proxy.unscripted.clear()

    run(scenario())


def test_a_redirect_is_not_followed_so_a_prompt_and_a_key_go_nowhere_the_config_did_not_name() -> None:
    async def scenario() -> None:
        async with Together() as played, Together(listed(MODEL, context_length=32_768)) as elsewhere:
            elsewhere.script(completed("from elsewhere"))
            played.script(Answer(status=307, headers={"location": f"{elsewhere.base_url}/chat/completions"}))
            played.models = Answer(status=307, headers={"location": f"{elsewhere.base_url}/models"})
            client = driver(played)
            with pytest.raises(ProviderStatusError) as redirected:
                await client.generate_text("p", 100, 0)
            assert redirected.value.status == 307
            with pytest.raises(RuntimeError, match=re.escape("Failed to discover model limits")):
                await client.limits()
            assert elsewhere.asked == []
            assert (len(played.lists), len(played.completions)) == (1, 1)

    run(scenario())


# ── the gate ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("structured_output", "said"),
    [(False, "says it does not"), (None, "does not say that it does")],
    ids=["the catalogue says it does not", "the catalogue says nothing"],
)
def test_a_model_not_known_to_hold_a_reply_to_a_schema_is_refused_before_any_request(structured_output: bool | None, said: str) -> None:
    # A generation the provider does not hold to the schema is what turns found entities into an empty result.
    async def scenario() -> None:
        async with Together() as played:
            played.script(completed("It was never built."))
            client = driver(played, dataclasses.replace(PLAIN, structured_output=structured_output), "acme/Model-Old")
            with pytest.raises(
                RuntimeError, match=re.escape("Model 'acme/Model-Old' is not known to hold a reply to a JSON Schema")
            ) as refused:
                await client.generate_structured("p", 1000, 0.3, PERSON)
            assert type(refused.value) is RuntimeError
            # Whose word it is: the catalogue's, and not the provider's, whose API states this of no model.
            assert f"the model catalogue it was given {said}" in str(refused.value)
            assert played.asked == []
            # Plain text wants no schema, and is asked for all the same.
            assert (await client.generate_text("p", 300, 0.2)).text == "It was never built."

    run(scenario())


# ── what comes back ─────────────────────────────────────────────────────


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
@pytest.mark.parametrize(
    ("reasoning", "reasoning_content"),
    [("I will look for rivers first.", None), (None, "I will look for rivers first.")],
    ids=["reasoning", "reasoning_content"],
)
def test_the_answer_is_the_content_alone_under_whichever_name_the_thinking_came_back(
    structured: bool, reasoning: str | None, reasoning_content: str | None
) -> None:
    said = written({"exact": "Paris"}) if structured else "The Loire."

    async def scenario() -> None:
        async with Together() as played:
            played.script(Completed(choices=[choice(said, reasoning=reasoning, reasoning_content=reasoning_content)], usage=counted(10, 5)))
            answer = await generation(driver(played, EFFORT), structured)
            if structured:
                assert answer == StructuredResponse(items=[{"exact": "Paris"}], stop_reason="end_turn", usage=COUNTED)
            else:
                assert answer == InferenceResponse(text="The Loire.", stop_reason="end_turn", usage=COUNTED)

    run(scenario())


def test_a_reply_cut_off_by_the_budget_stops_for_max_tokens_and_what_it_had_written_is_its_text() -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.script(completed("The Loire is", finish_reason="length", usage=counted(10, 100)))
            assert await driver(played).generate_text("p", 100, 0) == InferenceResponse(
                text="The Loire is", stop_reason="max_tokens", usage=TokenUsage(input_tokens=10, output_tokens=100)
            )

    run(scenario())


@pytest.mark.parametrize(
    ("finish_reason", "answered"),
    [
        # Two words for finished, which no page of Together's tells apart. No stop sequence is sent, so neither is one.
        ("stop", "end_turn"),
        ("eos", "end_turn"),
        ("length", "max_tokens"),
        ("tool_calls", "tool_calls"),
        ("function_call", "function_call"),
        # A word the library does not list is the provider's own, and is not read as an answer withheld: Together has no word for one.
        ("content_filter", "content_filter"),
        ("", "unknown"),
        (None, "unknown"),
    ],
)
def test_why_the_model_stopped_is_the_interfaces_word_where_it_has_one_and_otherwise_the_providers(
    finish_reason: str | None, answered: str
) -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.script(completed("text", finish_reason=finish_reason), completed(written(), finish_reason=finish_reason))
            client = driver(played)
            assert (await client.generate_text("p", 100, 0)).stop_reason == answered
            assert (await client.generate_structured("p", 100, 0, ELEMENT)).stop_reason == answered

    run(scenario())


def no_text(*choices: JsonValue) -> Answer:
    """A reply whose choices are `choices`, whatever they are."""
    return saying({"id": "played", "object": "chat.completion", "choices": [*choices], "usage": counted(10, 100, reasoning_tokens=100)})


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
@pytest.mark.parametrize(
    ("said", "stop_reason", "thinking_chars"),
    [
        (no_text(), "unknown", None),
        (saying({"id": "played", "object": "chat.completion", "choices": None, "usage": None}), "unknown", None),
        (no_text("not a choice"), "unknown", None),
        (no_text({"index": 0, "finish_reason": "length", "message": None}), "max_tokens", None),
        (no_text({"index": 0, "finish_reason": "length"}), "max_tokens", None),
        (no_text(choice(None, finish_reason="length")), "max_tokens", None),
        (no_text(choice("", finish_reason="length")), "max_tokens", None),
        (no_text(choice(None, finish_reason="length", reasoning="x" * 700)), "max_tokens", 700),
        (no_text(choice("", finish_reason="length", reasoning_content="x" * 40)), "max_tokens", 40),
        (no_text(choice("", finish_reason="stop")), "end_turn", None),
        (
            no_text({"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": [{"type": "text", "text": "x"}]}}),
            "end_turn",
            None,
        ),
    ],
    ids=[
        "no choice",
        "choices that are no list",
        "a choice that is no object",
        "a null message",
        "no message",
        "a null content",
        "an empty content",
        "thinking alone, as reasoning",
        "thinking alone, as reasoning_content",
        "finished with nothing written",
        "content that is not text",
    ],
)
def test_a_reply_with_no_text_is_a_failure_that_carries_the_stop_reason(
    structured: bool, said: Answer, stop_reason: str, thinking_chars: int | None, caplog: pytest.LogCaptureFixture
) -> None:
    # A model that reasons before it answers can spend the whole budget first. Cut off before its
    # first character is still cut off: the failure says so, and is not an empty text or an unreadable one.
    async def scenario() -> None:
        async with Together() as played:
            played.script(said)
            with pytest.raises(StructuredReadError) as empty:
                await generation(driver(played, EFFORT), structured)
            assert (empty.value.stop_reason, str(empty.value)) == (
                stop_reason,
                f"Structured response could not be read: response is empty (stop_reason: {stop_reason})",
            )

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (error,) = at(logging.ERROR, caplog)
    assert error.getMessage() == "Empty response from Together"
    # How much the model thought is said with it: a budget spent thinking reads as one.
    assert {key: vars(error)[key] for key in ("model", "stopReason", "thinkingChars")} == {
        "model": MODEL,
        "stopReason": stop_reason,
        "thinkingChars": thinking_chars,
    }


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
def test_a_reply_of_more_than_one_choice_is_a_failure_and_none_of_them_is_chosen(
    structured: bool, caplog: pytest.LogCaptureFixture
) -> None:
    # One answer is asked for. Which of two would be the answer is not this driver's to pick.
    async def scenario() -> None:
        async with Together() as played:
            played.script(Completed(choices=[choice(written()), choice(written({"exact": "Paris"}), index=1)], usage=counted(10, 5)))
            with pytest.raises(StructuredReadError) as unread:
                await generation(driver(played), structured)
            assert (unread.value.stop_reason, str(unread.value)) == (
                "unknown",
                "Structured response could not be read: the reply holds 2 choices, not one (stop_reason: unknown)",
            )

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (error,) = at(logging.ERROR, caplog)
    assert (error.getMessage(), vars(error)["model"], vars(error)["choices"]) == ("More than one choice from Together", MODEL, 2)


@pytest.mark.parametrize(
    ("reasoning", "reasoning_content", "chars"),
    [("x" * 500, None, 500), (None, "x" * 300, 300), ("x" * 5, "x" * 7, 12)],
    ids=["reasoning", "reasoning_content", "both"],
)
def test_thinking_by_a_model_told_not_to_is_warned_of_once_for_the_call_with_its_size(
    reasoning: str | None, reasoning_content: str | None, chars: int, caplog: pytest.LogCaptureFixture
) -> None:
    # The reasoning happened, is billed, and is counted among the tokens written.
    async def scenario() -> None:
        async with Together() as played:
            played.script(
                Completed(
                    choices=[choice(written(), reasoning=reasoning, reasoning_content=reasoning_content)],
                    usage=counted(10, 500, reasoning_tokens=495),
                )
            )
            await driver(played, HYBRID).generate_structured("p", 1000, 0, ELEMENT)

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (warned,) = at(logging.WARNING, caplog)
    assert warned.getMessage() == "Model produced hidden thinking despite reasoning.enabled:false"
    assert (vars(warned)["model"], vars(warned)["thinkingChars"]) == (MODEL, chars)


@pytest.mark.parametrize("facts", [EFFORT, PLAIN], ids=["its least effort was asked for", "no setting was sent"])
def test_thinking_by_a_model_that_was_not_told_not_to_is_not_warned_of(facts: CatalogueFacts, caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.script(Completed(choices=[choice("ok", reasoning="x" * 500)], usage=counted(10, 500)))
            await driver(played, facts).generate_text("p", 1000, 0)

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    assert at(logging.WARNING, caplog) == []


@pytest.mark.parametrize(
    "answer",
    [Answer(headers={"content-type": "text/html"}, body=b"<html>a gateway's page</html>"), saying(["not", "an", "object"])],
    ids=["not JSON", "JSON that is not an object"],
)
def test_an_answer_that_is_not_a_json_object_is_a_failure_and_not_an_empty_text(answer: Answer) -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.script(answer)
            with pytest.raises(StructuredReadError) as unread:
                await driver(played).generate_text("p", 100, 0)
            assert (unread.value.stop_reason, str(unread.value)) == (
                "unknown",
                "Structured response could not be read: the provider's answer is not a JSON object (stop_reason: unknown)",
            )

    run(scenario())


@pytest.mark.parametrize(
    ("said", "detail"),
    [
        # A backslash from OCR that was never escaped.
        (completed('[{"exact":"\\Villiam Crookes"}]'), "response is not valid JSON (stop_reason: end_turn)"),
        # Cut off by the budget: the same request is cut off the same way again, which the stop reason lets a worker know.
        (completed('[{"exact":"William Cro', finish_reason="length"), "response is not valid JSON (stop_reason: max_tokens)"),
        # What a model writes when the provider did not hold it to an array at the root.
        (completed('{"elements":[{"exact":"Paris"}]}'), "parsed to object, not an array (stop_reason: end_turn)"),
        (completed('"Paris"'), "parsed to string, not an array (stop_reason: end_turn)"),
        (completed("I found three places."), "response is not valid JSON (stop_reason: end_turn)"),
        # A model that writes its thinking into its answer, as DeepSeek-R1 does.
        (completed("<think>Paris is a place.</think>[]"), "response is not valid JSON (stop_reason: end_turn)"),
    ],
    ids=["an invalid escape", "cut off", "an object around the array", "text in quotes", "prose", "thinking written into the answer"],
)
def test_a_reply_that_cannot_be_read_as_the_array_raises_and_is_never_an_empty_one(said: Completed, detail: str) -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.script(said)
            with pytest.raises(StructuredReadError) as unread:
                await driver(played).generate_structured("p", 1000, 0.3, PERSON)
            assert str(unread.value) == f"Structured response could not be read: {detail}"

    run(scenario())


def test_an_empty_array_is_an_answer() -> None:
    # The other half: "the model found nothing" is a result, and does not raise.
    async def scenario() -> None:
        async with Together() as played:
            played.script(completed(written()))
            answer = await driver(played).generate_structured("p", 1000, 0.3, PERSON)
            assert answer == StructuredResponse(items=[], stop_reason="end_turn", usage=COUNTED)

    run(scenario())


def test_the_tokens_are_the_providers_on_either_kind_of_generation() -> None:
    async def scenario() -> None:
        async with Together() as played:
            # What was written includes what the model spent reasoning out of sight.
            usage = counted(412, 57, reasoning_tokens=40)
            played.script(completed("text", usage=usage), completed(written(), usage=usage))
            client = driver(played)
            told = TokenUsage(input_tokens=412, output_tokens=57)
            assert await client.generate_text("p", 100, 0) == InferenceResponse(text="text", stop_reason="end_turn", usage=told)
            assert await client.generate_structured("p", 100, 0, ELEMENT) == StructuredResponse(
                items=[], stop_reason="end_turn", usage=told
            )

    run(scenario())


@pytest.mark.parametrize(
    "usage", [None, {}, {"prompt_tokens": 412}, {"completion_tokens": 57}], ids=["no usage", "neither", "read alone", "written alone"]
)
def test_no_tokens_are_answered_where_the_provider_did_not_count_both_on_either_kind_of_generation(usage: JsonObject | None) -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.script(Completed(choices=[choice("text")], usage=usage), Completed(choices=[choice(written())], usage=usage))
            client = driver(played)
            # Not known is not nothing: a zero would say the call cost nothing.
            assert await client.generate_text("p", 100, 0) == InferenceResponse(text="text", stop_reason="end_turn", usage=None)
            assert await client.generate_structured("p", 100, 0, ELEMENT) == StructuredResponse(
                items=[], stop_reason="end_turn", usage=None
            )

    run(scenario())


def test_a_call_logs_what_the_other_drivers_do_at_the_same_levels(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.script(completed("hello"), completed(written({"exact": "A"})), completed("not an array"))
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
    asked, finished, _, structured, _, unread = records
    assert {key: vars(asked)[key] for key in ("model", "promptLength", "maxTokens", "temperature")} == {
        "model": MODEL,
        "promptLength": 6,
        "maxTokens": 100,
        "temperature": 0.2,
    }
    # The provider's id of the reply, for telling one answer from another in its logs and in ours: Together states no id of a request.
    assert {key: vars(finished)[key] for key in ("model", "textLength", "stopReason", "requestId")} == {
        "model": MODEL,
        "textLength": 5,
        "stopReason": "end_turn",
        "requestId": "played-1",
    }
    assert {key: vars(structured)[key] for key in ("model", "items", "stopReason", "requestId")} == {
        "model": MODEL,
        "items": 1,
        "stopReason": "end_turn",
        "requestId": "played-2",
    }
    assert {key: vars(unread)[key] for key in ("model", "textLength", "stopReason")} == {
        "model": MODEL,
        "textLength": 12,
        "stopReason": "end_turn",
    }


# ── failures ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("status", "asked"),
    [
        (408, 3),
        (409, 3),
        (429, 3),
        (500, 3),
        (503, 3),
        (504, 3),
        (524, 3),
        (529, 3),
        (400, 1),
        (401, 1),
        (402, 1),
        (403, 1),
        (404, 1),
        (422, 1),
    ],
)
def test_a_refused_generation_is_a_provider_status_error_with_the_librarys_failure_as_its_cause(status: int, asked: int) -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.script(*[together_error(status, kind="invalid_request_error", code=None, message="what the provider said")] * asked)
            with pytest.raises(ProviderStatusError) as failed:
                await driver(played).generate_text("p", 100, 0)
            cause = failed.value.__cause__
            assert isinstance(cause, together.APIStatusError)
            # What the library said of it, with the status and the provider's own words in it.
            assert (failed.value.status, str(failed.value)) == (status, cause.message)
            assert str(status) in str(failed.value)
            assert "what the provider said" in str(failed.value)
            # The retries are this driver's choice of two: a refusal the library asks again for is asked three times
            # in all, and any other once.
            assert played.generations == [said_to(MODEL, "p", 100, temperature=0)] * asked

    run(scenario())


@pytest.mark.parametrize(("status", "says", "asked"), [(500, "false", 1), (400, "true", 3)], ids=["not to ask again", "to ask again"])
def test_the_library_asks_again_or_does_not_as_a_header_of_the_refusal_says_whatever_the_status(status: int, says: str, asked: int) -> None:
    async def scenario() -> None:
        async with Together() as played:
            refusal = together_error(
                status, kind="error", code=None, message="what the provider said", headers={"x-should-retry": says, "retry-after-ms": "1"}
            )
            played.script(*[refusal] * asked)
            with pytest.raises(ProviderStatusError) as failed:
                await driver(played).generate_text("p", 100, 0)
            assert failed.value.status == status
            assert len(played.completions) == asked

    run(scenario())


def test_a_refusal_followed_by_an_answer_is_an_answer() -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.script(together_error(429, kind="rate_limit", code=None, message="the account is over its rate"), completed(written()))
            assert (await driver(played).generate_structured("p", 100, 0, ELEMENT)).items == []
            assert len(played.generations) == 2

    run(scenario())


def test_the_library_waits_as_long_as_the_provider_says_up_to_a_minute_and_otherwise_a_little_longer_each_time() -> None:
    # The waits are the library's: with nothing said, at least 0.75 s and then at least 1.5 s (a second, then two, each less
    # up to a quarter). A provider that says to wait longer than a minute is not waited for: it is asked again as if it had said nothing.
    def unsaid(status: int) -> Answer:
        return together_error(status, kind="server_error", code=None, message="overloaded", headers={})

    def told(seconds: int) -> Answer:
        return together_error(429, kind="rate_limit", code=None, message="slow down", headers={"retry-after": str(seconds)})

    async def scenario() -> None:
        async with Together() as played:
            played.script(unsaid(503), unsaid(500), completed("first"), told(3), completed("second"), told(61), completed("third"))
            client = driver(played)
            assert (await hurried(client.generate_text("p", 100, 0))).text == "first"
            assert (await hurried(client.generate_text("p", 100, 0))).text == "second"
            assert (await hurried(client.generate_text("p", 100, 0))).text == "third"
            arrived = [asked.at for asked in played.completions]
            first, second = arrived[1] - arrived[0], arrived[2] - arrived[1]
            as_told, beyond = arrived[4] - arrived[3], arrived[6] - arrived[5]
            # Each is held from below. The loop's clock is moved a quarter of a second at a time here, however long
            # a step really takes, so from above only a wait of the wrong size is refused.
            assert 0.75 <= first < 1.5, first
            assert 1.5 <= second < 3, second
            assert 3.0 <= as_told < 5, as_told
            assert 0.75 <= beyond < 3, beyond

    run(scenario())


def test_a_connection_that_ends_unanswered_is_asked_three_times_and_then_passed_on_as_the_library_reports_it() -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.script(HANG_UP, HANG_UP, HANG_UP)
            with pytest.raises(together.APIConnectionError) as ended:
                await hurried(driver(played).generate_text("p", 100, 0))
            # It carries no status: it is the library's failure, and none of those the interface declares.
            assert not hasattr(ended.value, "status")
            assert len(played.generations) == 3

    run(scenario())


def test_a_generation_that_takes_an_hour_is_neither_given_up_nor_asked_a_second_time() -> None:
    # This driver states no bound on a read: a generation ends when it is answered, or when its caller cancels it.
    async def scenario() -> None:
        async with Together() as played:
            played.script(HOLD)
            call = asyncio.ensure_future(driver(played).generate_text("p", 100, 0))
            await soon(played.arrived("POST", "/v1/chat/completions"))
            await pass_time(3600, step=30)
            assert not call.done()
            assert len(played.completions) == 1
            played.release(whole(completed("at last"), model=MODEL, number=1))
            assert (await soon(call)).text == "at last"
            assert len(played.completions) == 1

    run(scenario())


def test_left_to_itself_the_library_gives_a_generation_a_minute_and_then_sends_it_again() -> None:
    # The library's own bound, which a generation asked for whole outlasts: the provider says nothing until the answer is made.
    async def scenario() -> None:
        async with Together() as played:
            played.script(HOLD, HOLD)
            async with together.AsyncTogether(api_key=KEY, base_url=played.base_url) as library:
                call = asyncio.ensure_future(library.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": "p"}]))
                await soon(played.arrived("POST", "/v1/chat/completions"))
                await pass_time(55, step=5)
                assert len(played.completions) == 1
                await pass_time(10, step=1)
                await soon(played.arrived("POST", "/v1/chat/completions", 2))
                # The same generation, begun a second time, with nothing that tells the provider so.
                first, second = played.completions
                assert first.body == second.body
                call.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await call

    run(scenario())


# ── cancelling ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
def test_cancelling_a_generation_ends_its_task_cancelled_and_closes_the_connection(structured: bool) -> None:
    async def scenario() -> None:
        async with Together() as played:
            played.script(HOLD)
            call = asyncio.ensure_future(generation(driver(played), structured))
            await soon(played.arrived("POST", "/v1/chat/completions"))
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
            assert len(played.completions) == 1

    run(scenario())


# ── the extra ───────────────────────────────────────────────────────────

# The modules of Together's library, and of what it finds a coding agent with, that a program has imported.
LOADED = 'sorted(name for name in sys.modules if name.split(".")[0] in ("together", "detect_agent"))'

# A model's facts, as whoever makes a Together client hands them to it.
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
print(ollama.provider, {LOADED}, "semiont_inference.together" in sys.modules)
"""

# The factory does not make a Together client: `together` is not yet a provider the protocol names. Its module is asked for.
ASKING_FOR_TOGETHER = f"""
import sys
from semiont_inference.catalogue import CatalogueFacts, CatalogueLimit

facts = {FACTS}
before = {LOADED}
from semiont_inference.together import TogetherInferenceClient

client = TogetherInferenceClient(api_key="k", model="m", base_url="http://127.0.0.1:1/v1", facts=facts)
print(before, client.provider, "together" in sys.modules, "semiont_inference.together" in sys.modules)
"""

WITHOUT_TOGETHERS_LIBRARY = """
import sys

sys.modules["together"] = None  # as an interpreter has it where the library is not installed
from semiont_inference.factory import create_inference_client

try:
    import semiont_inference.together
except ModuleNotFoundError as missing:
    print(type(missing).__name__, "|", missing.name, "|", type(missing.__cause__).__name__, "|", missing)
print(create_inference_client(provider="ollama", model="llama3", base_url="http://127.0.0.1:1", api_key=None).provider)
"""


def program(source: str) -> str:
    """What the program `source` printed, run by an interpreter of its own."""
    ran = subprocess.run([sys.executable, "-c", source], capture_output=True, text=True, check=False)
    assert ran.returncode == 0, ran.stderr
    return ran.stdout


def test_the_package_and_another_providers_client_import_no_part_of_togethers_library() -> None:
    assert program(ASKING_FOR_ANOTHER) == "ollama [] False\n"


def test_asking_for_the_together_driver_is_what_imports_togethers_library_and_stating_a_models_facts_does_not() -> None:
    assert program(ASKING_FOR_TOGETHER) == "[] together True True\n"


def test_without_togethers_library_its_driver_fails_naming_the_extra_and_an_ollama_client_is_made() -> None:
    said = (
        "The Together driver needs Together's `together` library, which is not installed. "
        "It comes with the extra: install `semiont-inference[together]`."
    )
    assert program(WITHOUT_TOGETHERS_LIBRARY).splitlines() == [f"ModuleNotFoundError | together | ModuleNotFoundError | {said}", "ollama"]


# ── telemetry ───────────────────────────────────────────────────────────

# A model no other test names.
TELEMETRY_MODEL = "telemetry/Model-X"
PREFIX = "semiont.inference."


async def recorded_alone() -> JsonValue:
    """Generations of the driver that end each way a row of the telemetry table lists, and every point an in-memory reader then holds.

    A process's meter provider is installed once, and the reader another
    test installed is not this file's to read: so this runs in a process of
    its own.
    """
    reader = InMemoryMetricReader()
    metrics.set_meter_provider(MeterProvider(metric_readers=[reader]))
    async with Together() as played:
        played.script(
            completed("hello", usage=counted(4127, 571)),
            completed("not an array", usage=counted(10, 5)),
            # Nothing in it, and still counted by the provider: the tokens were spent, on thinking.
            Completed(choices=[choice(None, finish_reason="length", reasoning="x" * 9)], usage=counted(7, 3, reasoning_tokens=3)),
            # Its provider reports no tokens: it is counted as a call, and adds none.
            Completed(choices=[choice("hello")], usage=None),
            together_error(400, kind="invalid_request_error", code=None, message="the input is over the model's window"),
            HOLD,
        )
        client = driver(played, model=TELEMETRY_MODEL)
        await client.generate_text("p", 100, 0)
        with pytest.raises(StructuredReadError):
            await client.generate_structured("p", 100, 0, ELEMENT)
        with pytest.raises(StructuredReadError):
            await client.generate_text("p", 100, 0)
        await client.generate_text("p", 100, 0)
        with pytest.raises(ProviderStatusError):
            await client.generate_text("p", 100, 0)
        # A generation its caller cancelled ended, and not well.
        cancelled = asyncio.ensure_future(client.generate_text("p", 100, 0))
        await soon(played.arrived("POST", "/v1/chat/completions", 6))
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled

    data = reader.get_metrics_data()
    assert data is not None
    points: list[JsonValue] = []
    for resource in data.resource_metrics:
        for scope in resource.scope_metrics:
            for metric in scope.metrics:
                for point in metric.data.data_points:
                    attributes: JsonObject = {key: str(value) for key, value in (point.attributes or {}).items()}
                    if isinstance(metric.data, Sum) and metric.data.is_monotonic and isinstance(point, NumberDataPoint):
                        points.append({"name": metric.name, "instrument": "counter", "attributes": attributes, "counted": point.value})
                    elif isinstance(metric.data, Histogram) and isinstance(point, HistogramDataPoint):
                        points.append(
                            {
                                "name": metric.name,
                                "instrument": "histogram",
                                "unit": metric.unit,
                                "attributes": attributes,
                                "counted": point.count,
                            }
                        )
                    else:
                        points.append({"name": metric.name, "instrument": "another", "attributes": attributes})
    return points


@pytest.fixture(scope="module")
def recorded() -> list[JsonObject]:
    """Every point `recorded_alone` left, of the metrics this package records."""
    points = objects(_JSON.validate_json(alone("recorded").stdout), "the points")
    return [point for point in points if text(point["name"], "a name").startswith(PREFIX)]


def test_what_the_driver_records_is_the_three_the_telemetry_table_lists_by_the_tables_keys_under_its_own_providers_name(
    recorded: list[JsonObject],
) -> None:
    # The table's values for `inference.provider` do not have `together`: the protocol's list of providers is closed, and
    # gains it with the service that makes this driver. So the points are held to the table's keys, and to every other value.
    rows = {text(row["name"], "a name"): row for row in objects(read(SPEC / "service-telemetry/telemetry.json")["metrics"], "the metrics")}
    listed_rows = {name: row for name, row in rows.items() if name.startswith(PREFIX)}
    assert listed_rows, "the table lists no inference metric: this gate reads nothing"
    assert {text(point["name"], "a name") for point in recorded} == set(listed_rows)

    for name, row in listed_rows.items():
        points = [point for point in recorded if point["name"] == name]
        attributes = objects(row["attributes"], "the attributes")
        for point in points:
            assert point["instrument"] == row["instrument"], name
            carried = thing(point["attributes"], "the attributes")
            assert set(carried) == {text(attribute["key"], "a key") for attribute in attributes}, name
            assert (carried["inference.provider"], carried["inference.model"]) == ("together", TELEMETRY_MODEL)
        for attribute in attributes:
            key = text(attribute["key"], "a key")
            if "values" in attribute and key != "inference.provider":
                seen = {text(thing(point["attributes"], "the attributes")[key], key) for point in points}
                assert seen == set(strings(attribute["values"], "the values")), f"{name}: {key} was {seen}"


def test_a_generation_is_counted_once_by_how_it_ended_and_its_tokens_are_the_providers(recorded: list[JsonObject]) -> None:
    def by(metric: str, key: str) -> dict[str, JsonValue]:
        return {
            text(thing(point["attributes"], "the attributes")[key], key): point["counted"]
            for point in recorded
            if point["name"] == f"{PREFIX}{metric}"
        }

    # Two answered; four not: unreadable, empty, refused, cancelled.
    calls = by("calls", "inference.outcome")
    assert calls == {"success": 2, "error": 4}
    # What the provider counted, the failing ones too, and nothing for a call whose provider reported none.
    assert by("tokens", "inference.direction") == {"input": 4127 + 10 + 7, "output": 571 + 5 + 3}
    # Every generation is timed, the failing ones too, in milliseconds.
    assert by("duration", "inference.outcome") == calls
    assert [point["unit"] for point in recorded if point["name"] == f"{PREFIX}duration"] == ["ms", "ms"]


# ── run as a program ────────────────────────────────────────────────────

# What `alone` runs, each in an interpreter of its own.
ALONE: Final[dict[str, Callable[[], Coroutine[None, None, JsonValue]]]] = {
    "asked": asked_alone,
    "logged": logged_alone,
    "recorded": recorded_alone,
}

if __name__ == "__main__":
    print(_JSON.dump_json(run(ALONE[sys.argv[1]]())).decode())
