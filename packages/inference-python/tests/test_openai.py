"""The OpenAI driver, against a Responses API this test plays over HTTP.

The driver reaches the provider through OpenAI's own library, and the library
is not replaced or patched: it sends real requests to the stand-in, which
answers each generation from what a test scripted. What arrives is held
exactly, the headers too.

OpenAI's API states nothing of a model, so a driver is handed its model's
facts by whoever makes it. Each case here states the facts it rests on. One
test reads a real catalogue file, and holds the driver to every entry of
OpenAI's in it.
"""

import asyncio
import dataclasses
import logging
import re
from typing import get_args

import openai
import pytest
from aio import hurried, pass_time, run, settle, soon
from openai.types.responses import ResponseError
from provider import (
    HANG_UP,
    HOLD,
    Answer,
    OpenAI,
    Responded,
    counted,
    message,
    openai_error,
    output_text,
    reasoning_item,
    refusal_part,
    responded,
    saying,
)
from pydantic import JsonValue, TypeAdapter
from spec import PACKAGE, JsonObject, objects, read, strings, thing

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
    ProviderWithheldError,
    StructuredReadError,
    StructuredResponse,
    TokenUsage,
)
from semiont_inference.openai import OpenAIInferenceClient

KEY = "sk-played-key"
CATALOGUE = PACKAGE / "tests/catalogue/model-catalogue.json"
COUNTED = TokenUsage(input_tokens=10, output_tokens=5)
REFUSAL = "I'm sorry, I cannot assist with that request."

_JSON = TypeAdapter[JsonValue](JsonValue)

# From least to most, as the driver's design orders them. A catalogue does not always list them so.
LEAST_FIRST = ("none", "minimal", "low", "medium", "high", "xhigh", "max")

ELEMENT: JsonObject = {"type": "object", "properties": {"exact": {"type": "string"}}, "required": ["exact"], "additionalProperties": False}
# What OpenAI's strict mode is sent for an array of ELEMENT: the array as the one property of an object.
ELEMENT_SENT: JsonObject = {
    "type": "object",
    "properties": {"elements": {"type": "array", "items": ELEMENT}},
    "required": ["elements"],
    "additionalProperties": False,
}

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
# The same for PERSON, whose `prefix` and `suffix` are optional: each is required there, and takes null.
PERSON_SENT: JsonObject = {
    "type": "object",
    "properties": {
        "elements": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "exact": {"type": "string"},
                    "entityType": {"type": "string"},
                    "prefix": {"type": ["string", "null"]},
                    "suffix": {"type": ["string", "null"]},
                },
                "required": ["exact", "entityType", "prefix", "suffix"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["elements"],
    "additionalProperties": False,
}


def efforts(*values: ReasoningEffort) -> tuple[ReasoningOption, ...]:
    """Reasoning set by an effort, of those named: the one way OpenAI's models have it set."""
    return (EffortOption(type="effort", values=values),)


# A model that does not reason: no way to set its reasoning is stated. It holds a reply to a schema, and takes a temperature.
PLAIN = CatalogueFacts(
    limit=CatalogueLimit(context=128_000, input=None, output=16_384),
    reasoning=False,
    reasoning_options=None,
    status=None,
    structured_output=True,
    temperature=True,
)
# A model that reasons and can be told not to: its least effort is `none`, and it takes a temperature.
QUIET = CatalogueFacts(
    limit=CatalogueLimit(context=400_000, input=272_000, output=128_000),
    reasoning=True,
    reasoning_options=efforts("none", "low", "medium", "high"),
    status=None,
    structured_output=True,
    temperature=True,
)
# A model that reasons whatever it is told: its least effort is `minimal`, and it takes no temperature.
THINKING = dataclasses.replace(QUIET, reasoning_options=efforts("minimal", "low", "medium", "high"), temperature=False)


def driver(played: OpenAI, facts: CatalogueFacts = PLAIN, model: str = "gpt-x") -> OpenAIInferenceClient:
    return OpenAIInferenceClient(api_key=KEY, model=model, base_url=played.base_url, facts=facts)


def said_to(model: str, prompt: str, max_output_tokens: int, **rest: JsonValue) -> JsonObject:
    """A request for plain text, as it arrives: the model, the prompt, the budget, that nothing is to be kept, and what `rest` states."""
    return {"model": model, "input": prompt, "max_output_tokens": max_output_tokens, "store": False, **rest}


def held_to(schema: JsonObject) -> JsonObject:
    """What a structured request carries beside the rest: the schema, under a name, and that the reply is to be held to it."""
    return {"format": {"type": "json_schema", "name": "elements", "strict": True, "schema": schema}}


def wrapped(*items: JsonValue) -> str:
    """A reply's text, as a model held to the wrapping object writes it."""
    return _JSON.dump_json({"elements": [*items]}).decode()


def cut_off(*output: JsonObject, usage: JsonObject | None = None) -> Responded:
    """A reply the budget ended."""
    return Responded(
        output=[*output], usage=counted(10, 100) if usage is None else usage, status="incomplete", incomplete="max_output_tokens"
    )


async def generation(client: OpenAIInferenceClient, structured: bool) -> InferenceResponse | StructuredResponse:
    if structured:
        return await client.generate_structured("p", 100, 0, ELEMENT)
    return await client.generate_text("p", 100, 0)


def ours(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_inference"]


def errors(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in ours(caplog) if record.levelno == logging.ERROR]


# ── what it is ──────────────────────────────────────────────────────────


def test_it_is_a_client_of_the_provider_openai_and_says_what_a_worker_asks_of_any_client() -> None:
    client: InferenceClient = OpenAIInferenceClient(api_key=KEY, model="gpt-x", base_url="http://127.0.0.1:1/v1", facts=PLAIN)
    assert (client.provider, client.model_id, client.max_concurrency, client.verify_detection_yield) == ("openai", "gpt-x", 4, True)


# ── limits ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("facts", "stated"),
    [
        (PLAIN, InferenceLimits(context_tokens=128_000, max_output_tokens=16_384, output_tokens_per_hour=None, accepts_temperature=True)),
        # The whole window, which what is read and what is written share: not the 272,000 the model reads at most.
        (QUIET, InferenceLimits(context_tokens=400_000, max_output_tokens=128_000, output_tokens_per_hour=None, accepts_temperature=True)),
        (
            THINKING,
            InferenceLimits(context_tokens=400_000, max_output_tokens=128_000, output_tokens_per_hour=None, accepts_temperature=False),
        ),
    ],
    ids=["a model that does not reason", "one that can be told not to", "one that reasons whatever it is told"],
)
def test_the_limits_are_the_facts_it_was_handed_and_the_provider_is_asked_nothing(facts: CatalogueFacts, stated: InferenceLimits) -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            client = driver(played, facts)
            assert await client.limits() == stated
            assert await client.limits() == stated
            assert played.asked == []

    run(scenario())


# ── the request ─────────────────────────────────────────────────────────


def test_plain_text_is_one_request_of_exactly_these_members() -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(responded("The Loire."))
            answer = await driver(played, QUIET).generate_text("Name one river of France.", 200, 0.3)
            assert answer == InferenceResponse(text="The Loire.", stop_reason="end_turn", usage=COUNTED)
            # Nothing is to be kept, and the least reasoning is asked for. No schema, no stream, no tool, no label of ours.
            assert played.generations == [said_to("gpt-x", "Name one river of France.", 200, reasoning={"effort": "none"}, temperature=0.3)]
            assert [f"{asked.method} {asked.path}" for asked in played.asked] == ["POST /v1/responses"]

    run(scenario())


def test_a_structured_generation_sends_the_schema_rewritten_for_strict_mode_and_reads_the_array_out_of_its_wrapper() -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(
                responded(
                    wrapped(
                        {"exact": "Paris", "entityType": "Place", "prefix": None, "suffix": " is"},
                        {"exact": 'the "best" café', "entityType": "Place", "prefix": "at ", "suffix": None},
                    )
                )
            )
            answer = await driver(played, QUIET).generate_structured("Extract places", 1000, 0, PERSON)
            assert played.generations == [
                {**said_to("gpt-x", "Extract places", 1000, reasoning={"effort": "none"}, temperature=0), "text": held_to(PERSON_SENT)}
            ]
            # A null stands for a property left out, and is taken out: an element reads as another provider would have written it.
            assert answer == StructuredResponse(
                items=[
                    {"exact": "Paris", "entityType": "Place", "suffix": " is"},
                    {"exact": 'the "best" café', "entityType": "Place", "prefix": "at "},
                ],
                stop_reason="end_turn",
                usage=COUNTED,
            )

    run(scenario())


@pytest.mark.parametrize(
    ("options", "least"),
    [
        (efforts("none", "low", "medium", "high"), "none"),
        (efforts("minimal", "none"), "none"),
        (efforts("minimal", "low", "medium", "high"), "minimal"),
        (efforts("high", "medium", "low"), "low"),
        (efforts("max", "xhigh", "medium", "high"), "medium"),
        (efforts("xhigh", "high"), "high"),
        (efforts("max", "xhigh"), "xhigh"),
        (efforts("max"), "max"),
        ((ToggleOption(type="toggle"), EffortOption(type="effort", values=("high", "low"))), "low"),
        ((EffortOption(type="effort", values=("high",)), EffortOption(type="effort", values=("medium", "minimal"))), "minimal"),
        ((ToggleOption(type="toggle"),), None),
        ((BudgetTokensOption(type="budget_tokens", min=0, max=24_576),), None),
        (efforts(), None),
        ((), None),
        (None, None),
    ],
    ids=[
        "listed from least to most",
        "none listed after minimal",
        "minimal is its least",
        "listed from most to least",
        "listed in no order",
        "high before xhigh",
        "xhigh before max",
        "max alone",
        "an effort beside a toggle",
        "two lists of efforts",
        "a toggle alone",
        "a budget of tokens alone",
        "an effort of no values",
        "no way stated",
        "a model that does not reason",
    ],
)
def test_the_least_reasoning_the_facts_allow_is_asked_for_on_either_kind_of_generation(
    options: tuple[ReasoningOption, ...] | None, least: str | None
) -> None:
    # OpenAI's API takes reasoning by a named effort and by nothing else, so a model whose facts name no
    # effort (a toggle, a budget of tokens, or no way at all) is sent no reasoning setting.
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(responded("ok"), responded(wrapped()))
            client = driver(played, dataclasses.replace(THINKING, reasoning_options=options))
            await client.generate_text("p", 100, 0)
            await client.generate_structured("p", 100, 0, ELEMENT)
            stated: JsonObject = {} if least is None else {"reasoning": {"effort": least}}
            assert played.generations == [
                said_to("gpt-x", "p", 100, **stated),
                {**said_to("gpt-x", "p", 100, **stated), "text": held_to(ELEMENT_SENT)},
            ]

    run(scenario())


@pytest.mark.parametrize(
    ("temperature", "options", "sent", "accepted"),
    [
        (True, None, True, True),
        (True, efforts("none", "low", "medium"), True, True),
        # OpenAI refuses a temperature beside any effort but `none`, and `minimal` is the least this model takes.
        (True, efforts("minimal", "low", "medium"), False, False),
        (False, None, False, False),
        (False, efforts("none", "low", "medium"), False, False),
        (None, None, False, None),
        (None, efforts("none", "low", "medium"), False, None),
    ],
    ids=[
        "taken, by a model that does not reason",
        "taken, by a model told not to reason",
        "taken, by a model that must reason",
        "refused, by a model that does not reason",
        "refused, by a model told not to reason",
        "not stated, of a model that does not reason",
        "not stated, of a model told not to reason",
    ],
)
def test_a_temperature_is_sent_only_where_the_facts_say_it_is_taken_and_no_reasoning_is_asked_for_and_the_limits_say_the_same(
    temperature: bool | None, options: tuple[ReasoningOption, ...] | None, sent: bool, accepted: bool | None
) -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(responded("ok"), responded(wrapped()))
            client = driver(played, dataclasses.replace(PLAIN, temperature=temperature, reasoning_options=options))
            await client.generate_text("p", 100, 0.3)
            await client.generate_structured("p", 100, 0.3, ELEMENT)
            assert [body.get("temperature") for body in played.generations] == ([0.3, 0.3] if sent else [None, None])
            assert ["temperature" in body for body in played.generations] == [sent, sent]
            # What the limits say of a temperature is what the requests do with one.
            assert (await client.limits()).accepts_temperature is accepted

    run(scenario())


def test_every_openai_entry_of_a_real_catalogue_is_asked_as_the_entry_says() -> None:
    # The facts as a worker gets them: read from a catalogue file, and handed to the driver. What each entry
    # says is read a second time here, from the file as JSON, and by this test's own statement of the order.
    catalogue = read_catalogue(CATALOGUE)
    entries = thing(thing(thing(read(CATALOGUE)["providers"], "the providers")["openai"], "openai")["models"], "the models")
    assert len(entries) > 20, "the catalogue has few of OpenAI's models: this test reads little"
    asked_for: set[str | None] = set()

    async def scenario() -> None:
        async with OpenAI() as played:
            for model_id, stated in entries.items():
                entry = thing(stated, model_id)
                facts = catalogue_facts(catalogue, "openai", model_id)
                assert facts is not None, model_id
                options = entry["reasoning_options"]
                named = [
                    effort
                    for option in ([] if options is None else objects(options, "the options"))
                    if option["type"] == "effort"
                    for effort in strings(option["values"], "the efforts")
                ]
                least = min(named, key=LEAST_FIRST.index) if named else None
                takes_temperature = entry["temperature"]
                assert takes_temperature is None or isinstance(takes_temperature, bool)
                sent = takes_temperature is True and least in (None, "none")
                limit = thing(entry["limit"], "the limit")
                context, output = limit["context"], limit["output"]
                assert isinstance(context, int)
                assert isinstance(output, int)

                client = driver(played, facts, model_id)
                assert await client.limits() == InferenceLimits(
                    context_tokens=context,
                    max_output_tokens=output,
                    output_tokens_per_hour=None,
                    accepts_temperature=sent if takes_temperature is True else takes_temperature,
                ), model_id
                played.script(responded("ok"))
                await client.generate_text("p", 100, 0.3)
                expected = said_to(model_id, "p", 100)
                if least is not None:
                    expected["reasoning"] = {"effort": least}
                if sent:
                    expected["temperature"] = 0.3
                assert played.generations[-1] == expected, model_id
                asked_for.add(least)

    run(scenario())
    # Models that do not reason, ones that can be told not to, and ones whose least is something more.
    assert {None, "none"} < asked_for, asked_for


def test_an_element_schema_that_cannot_be_rewritten_is_refused_before_any_request() -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            bounded: JsonObject = {"type": "object", "properties": {"exact": {"type": "string", "minLength": 1}}, "required": ["exact"]}
            with pytest.raises(ValueError, match=re.escape("`minLength` is a keyword this package does not rewrite")):
                await driver(played).generate_structured("p", 100, 0, bounded)
            assert played.asked == []

    run(scenario())


# ── what the library does unasked ───────────────────────────────────────

# What the library reads from the environment whatever it is given, each set to what a driver must not send.
UNASKED = {
    "OPENAI_API_KEY": "sk-from-the-environment",
    "OPENAI_ADMIN_KEY": "sk-admin-from-the-environment",
    "OPENAI_BASE_URL": "http://127.0.0.1:1/v1",
    "OPENAI_ORG_ID": "org-from-the-environment",
    "OPENAI_PROJECT_ID": "proj-from-the-environment",
    "OPENAI_CUSTOM_HEADERS": "\n".join(
        ["Authorization: Bearer sk-custom-from-the-environment", "User-Agent: from-the-environment", "X-From-The-Environment: 1"]
    ),
}
PROXIES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")

# The headers of a request: what HTTP itself needs, and the four this driver states.
SENT = {"host", "accept-encoding", "connection", "content-length", "accept", "content-type", "user-agent", "authorization"}


def test_a_request_carries_what_this_driver_states_and_nothing_the_library_or_the_environment_would_add(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name, value in UNASKED.items():
        monkeypatch.setenv(name, value)

    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(responded("ok"), responded(wrapped()))
            client = driver(played, THINKING)
            await client.generate_text("p", 100, 0)
            await client.generate_structured("p", 100, 0, ELEMENT)
            assert len(played.responses) == 2
            for asked in played.responses:
                # The one more is the library's own mark on a request whose answer is asked for with its headers. It reads
                # the mark back itself, and it cannot be left off. Nothing says how long a read may take: there is no such bound.
                assert set(asked.headers) == SENT | {"x-stainless-raw-response"}
                assert {
                    name: asked.headers[name]
                    for name in ("host", "content-length", "accept", "content-type", "user-agent", "authorization")
                } == {
                    "host": played.origin.removeprefix("http://"),
                    "content-length": str(len(asked.body)),
                    "accept": "application/json",
                    "content-type": "application/json",
                    # The library's name and version, and nothing of the machine it runs on.
                    "user-agent": f"AsyncOpenAI/Python {openai.__version__}",
                    # The key it was given, whatever the environment says.
                    "authorization": f"Bearer {KEY}",
                }

    run(scenario())


def test_left_to_itself_the_library_sends_what_this_driver_omits(monkeypatch: pytest.MonkeyPatch) -> None:
    # This asks the library itself, so a release that changes what it adds on its own fails here and is read again.
    for name, value in UNASKED.items():
        monkeypatch.setenv(name, value)

    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(responded("ok"))
            async with openai.AsyncOpenAI(api_key=KEY, base_url=played.base_url, max_retries=0) as library:
                await library.responses.create(model="gpt-x", input="p")
            (asked,) = played.responses
            assert set(asked.headers) - SENT == {
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
            assert asked.headers["x-stainless-read-timeout"] == "600"
            assert (asked.headers["openai-organization"], asked.headers["openai-project"]) == (
                "org-from-the-environment",
                "proj-from-the-environment",
            )
            # A line of the environment's replaced the key it was given, and another named the client.
            assert (asked.headers["authorization"], asked.headers["user-agent"]) == (
                "Bearer sk-custom-from-the-environment",
                "from-the-environment",
            )
            # And it does not say that nothing is to be kept: the provider keeps a response thirty days unless told not to.
            assert asked.json() == {"model": "gpt-x", "input": "p"}

    run(scenario())


def test_the_address_it_was_given_is_the_address_asked_whatever_proxy_and_certificates_the_environment_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        async with OpenAI() as played, OpenAI() as proxy:
            for name in PROXIES:
                monkeypatch.setenv(name, proxy.origin)
            for name in ("NO_PROXY", "no_proxy"):
                monkeypatch.delenv(name, raising=False)
            monkeypatch.setenv("SSL_CERT_FILE", "/nowhere/certificates.pem")
            played.script(responded("ok"))
            assert (await driver(played).generate_text("p", 100, 0)).text == "ok"
            assert proxy.asked == []
            assert len(played.responses) == 1

    run(scenario())


def test_left_to_itself_the_library_asks_the_proxy_the_environment_names(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        async with OpenAI() as played, OpenAI() as proxy:
            for name in PROXIES:
                monkeypatch.setenv(name, proxy.origin)
            for name in ("NO_PROXY", "no_proxy"):
                monkeypatch.delenv(name, raising=False)
            async with openai.AsyncOpenAI(api_key=KEY, base_url=played.base_url, max_retries=0) as library:
                with pytest.raises(openai.NotFoundError):
                    await library.responses.create(model="gpt-x", input="p")
            # The request went to the proxy, which is asked for the whole address, and the provider saw nothing.
            assert played.asked == []
            assert proxy.unscripted == [f"POST {played.base_url}/responses"]
            proxy.unscripted.clear()

    run(scenario())


def test_a_redirect_is_not_followed_so_a_prompt_goes_nowhere_the_config_did_not_name() -> None:
    async def scenario() -> None:
        async with OpenAI() as played, OpenAI() as elsewhere:
            elsewhere.script(responded("from elsewhere"))
            played.script(Answer(status=307, headers={"location": f"{elsewhere.base_url}/responses"}))
            with pytest.raises(ProviderStatusError) as redirected:
                await driver(played).generate_text("p", 100, 0)
            assert redirected.value.status == 307
            assert elsewhere.asked == []
            assert len(played.responses) == 1

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
        async with OpenAI() as played:
            played.script(responded("It was never built."))
            client = driver(played, dataclasses.replace(PLAIN, structured_output=structured_output), "gpt-legacy")
            with pytest.raises(
                RuntimeError, match=re.escape("Model 'gpt-legacy' is not known to hold a reply to a JSON Schema")
            ) as refused:
                await client.generate_structured("p", 1000, 0.3, PERSON)
            assert type(refused.value) is RuntimeError
            # Whose word it is: the catalogue's, and not the provider's, which states this of no model.
            assert f"the model catalogue it was given {said}" in str(refused.value)
            assert played.asked == []
            # Plain text wants no schema, and is asked for all the same.
            assert (await client.generate_text("p", 300, 0.2)).text == "It was never built."

    run(scenario())


# ── what comes back ─────────────────────────────────────────────────────


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
def test_the_text_is_the_final_answers_and_not_what_the_model_said_on_the_way_to_it(structured: bool) -> None:
    # The library's own `output_text` joins the text of every message of a reply, commentary included.
    final = wrapped({"exact": "Paris"}) if structured else "The Loire."

    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(
                Responded(
                    output=[
                        reasoning_item(),
                        message(output_text("I will look for rivers first. "), phase="commentary"),
                        message(output_text(final), phase="final_answer"),
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
@pytest.mark.parametrize(
    "output",
    [
        [message(output_text(wrapped()), output_text(wrapped()))],
        [message(output_text(wrapped())), message(output_text(wrapped()), phase="final_answer")],
    ],
    ids=["two texts in one message", "two final messages"],
)
def test_a_reply_with_more_than_one_final_text_is_a_failure_and_none_of_them_is_chosen(structured: bool, output: list[JsonObject]) -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(Responded(output=output, usage=counted(10, 5)))
            with pytest.raises(StructuredReadError) as unread:
                await generation(driver(played), structured)
            assert (unread.value.stop_reason, str(unread.value)) == (
                "end_turn",
                "Structured response could not be read: the reply holds 2 final texts, not one (stop_reason: end_turn)",
            )

    run(scenario())


def test_a_reply_cut_off_by_the_budget_stops_for_max_tokens_and_what_it_had_written_is_its_text() -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(cut_off(reasoning_item(), message(output_text("The Loire is"))))
            assert await driver(played).generate_text("p", 100, 0) == InferenceResponse(
                text="The Loire is", stop_reason="max_tokens", usage=TokenUsage(input_tokens=10, output_tokens=100)
            )

    run(scenario())


@pytest.mark.parametrize(
    ("status", "incomplete", "answered"),
    [
        ("completed", None, "end_turn"),
        ("incomplete", "max_output_tokens", "max_tokens"),
        ("incomplete", "max_messages", "max_messages"),
        ("incomplete", "steered", "steered"),
        ("incomplete", None, "incomplete"),
        ("cancelled", None, "cancelled"),
        ("in_progress", None, "in_progress"),
        ("queued", None, "queued"),
        (None, None, "unknown"),
    ],
)
def test_why_the_model_stopped_is_the_interfaces_word_where_it_has_one_and_otherwise_the_providers(
    status: str | None, incomplete: str | None, answered: str
) -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(
                Responded(output=[message(output_text("text"))], usage=counted(10, 5), status=status, incomplete=incomplete),
                Responded(output=[message(output_text(wrapped()))], usage=counted(10, 5), status=status, incomplete=incomplete),
            )
            client = driver(played)
            assert (await client.generate_text("p", 100, 0)).stop_reason == answered
            assert (await client.generate_structured("p", 100, 0, ELEMENT)).stop_reason == answered

    run(scenario())


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
@pytest.mark.parametrize(
    ("output", "types"),
    [
        ([], []),
        ([reasoning_item()], ["reasoning"]),
        ([message(output_text(""))], ["message"]),
        ([reasoning_item(), message(output_text("I will look for rivers first."), phase="commentary")], ["reasoning", "message"]),
    ],
    ids=["nothing at all", "reasoning alone", "an empty text", "commentary alone"],
)
def test_a_reply_with_no_final_text_is_a_failure_that_carries_the_stop_reason(
    structured: bool, output: list[JsonObject], types: list[str], caplog: pytest.LogCaptureFixture
) -> None:
    # A model that reasons before it answers can spend the whole budget first. Cut off before its
    # first character is still cut off: the failure says so, and is not an empty text or an unreadable one.
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(cut_off(*output, usage=counted(10, 100, reasoning_tokens=100)))
            with pytest.raises(StructuredReadError) as empty:
                await generation(driver(played), structured)
            assert (empty.value.stop_reason, str(empty.value)) == (
                "max_tokens",
                "Structured response could not be read: response is empty (stop_reason: max_tokens)",
            )

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (error,) = errors(caplog)
    assert error.getMessage() == "Empty response from OpenAI"
    assert {key: vars(error)[key] for key in ("model", "stopReason", "outputTypes")} == {
        "model": "gpt-x",
        "stopReason": "max_tokens",
        "outputTypes": types,
    }


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
@pytest.mark.parametrize(
    ("said", "reason", "detail"),
    [
        (Responded(output=[message(refusal_part(REFUSAL))], usage=counted(9, 3)), "refusal", f"refusal: {REFUSAL}"),
        (
            Responded(output=[message(output_text(wrapped({"exact": "Paris"})), refusal_part(REFUSAL))], usage=counted(9, 3)),
            "refusal",
            f"refusal: {REFUSAL}",
        ),
        (Responded(output=[message(refusal_part(""))], usage=counted(9, 3)), "refusal", "refusal"),
        (
            Responded(
                output=[message(output_text(wrapped({"exact": "Paris"})))],
                usage=counted(9, 3),
                status="incomplete",
                incomplete="content_filter",
            ),
            "content_filter",
            "content_filter",
        ),
        (
            Responded(output=[], usage=None, status="failed", error={"code": "invalid_prompt", "message": "Your prompt was flagged."}),
            "invalid_prompt",
            "invalid_prompt: Your prompt was flagged.",
        ),
    ],
    ids=[
        "the model refused",
        "the model refused, beside what it had written",
        "the model refused, with no word of why",
        "a filter ended the reply",
        "the request was blocked",
    ],
)
def test_an_answer_the_provider_withheld_is_a_failure_of_its_own_in_each_of_its_shapes_and_nothing_it_carried_is_returned(
    structured: bool, said: Responded, reason: str, detail: str, caplog: pytest.LogCaptureFixture
) -> None:
    # A refusal comes back `completed`, with a part that says so where the text would be. Read by the text alone
    # it is an empty reply, or, beside text, an answer. What a withheld reply carries is no answer, however much of one it looks like.
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(said)
            with pytest.raises(ProviderWithheldError) as withheld:
                await generation(driver(played), structured)
            assert (withheld.value.reason, str(withheld.value)) == (reason, f"The provider withheld its answer: {detail}")
            assert len(played.responses) == 1

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (error,) = errors(caplog)
    assert error.getMessage() == "The provider withheld its answer"
    assert {key: vars(error)[key] for key in ("model", "status", "reason")} == {"model": "gpt-x", "status": said.status, "reason": reason}


# The codes a failed reply states, as the library lists them, by what this driver makes of each: a request the
# provider blocked, which is an answer withheld, and a generation that broke, which is not.
BLOCKED = {"invalid_prompt", "bio_policy", "misalignment_policy_violation", "image_content_policy_violation"}
BROKE = {
    "server_error",
    "rate_limit_exceeded",
    "data_residency_mismatch",
    "vector_store_timeout",
    "invalid_image",
    "invalid_image_format",
    "invalid_base64_image",
    "invalid_image_url",
    "image_too_large",
    "image_too_small",
    "image_parse_error",
    "invalid_image_mode",
    "image_file_too_large",
    "unsupported_image_media_type",
    "empty_image_file",
    "failed_to_download_image",
    "image_file_not_found",
}


def test_every_code_of_a_failed_reply_that_the_library_lists_is_read_here_as_a_block_or_as_a_failure() -> None:
    # The library's own list. A release that adds a code fails here, and the code is then read: a block, or a failure.
    listed = set(get_args(ResponseError.model_fields["code"].annotation))
    assert listed == BLOCKED | BROKE
    assert not BLOCKED & BROKE


@pytest.mark.parametrize("code", sorted(BLOCKED))
def test_a_failed_reply_that_states_a_block_is_an_answer_withheld_for_the_reason_it_states(code: str) -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(Responded(output=[], usage=None, status="failed", error={"code": code, "message": "The provider said why."}))
            with pytest.raises(ProviderWithheldError) as withheld:
                await driver(played).generate_structured("p", 100, 0, ELEMENT)
            assert (withheld.value.reason, str(withheld.value)) == (
                code,
                f"The provider withheld its answer: {code}: The provider said why.",
            )

    run(scenario())


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
@pytest.mark.parametrize(
    ("error", "said"),
    [
        *(
            (
                {"code": code, "message": "The provider said why."},
                f"OpenAI reported that the generation failed: {code}: The provider said why.",
            )
            for code in sorted(BROKE)
        ),
        # A code no release of the library lists is not known to be a block, and only what is known to be withheld is called so.
        (
            {"code": "a_code_of_tomorrow", "message": "The provider said why."},
            "OpenAI reported that the generation failed: a_code_of_tomorrow: The provider said why.",
        ),
        ({"code": "server_error"}, "OpenAI reported that the generation failed: server_error"),
        (None, "OpenAI reported that the generation failed, and stated no code"),
    ],
    ids=[*sorted(BROKE), "a code the library does not list", "a code and no message", "nothing stated"],
)
def test_a_failed_reply_that_states_no_block_is_a_plain_failure_with_no_status_and_is_not_called_withheld(
    structured: bool, error: JsonObject | None, said: str, caplog: pytest.LogCaptureFixture
) -> None:
    # A server that failed, or an account over its rate, withheld nothing: asked again, it may answer.
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(Responded(output=[], usage=counted(10, 0), status="failed", error=error))
            with pytest.raises(RuntimeError) as failed:
                await generation(driver(played), structured)
            assert type(failed.value) is RuntimeError
            assert not hasattr(failed.value, "status")
            assert str(failed.value) == said
            # The library does not ask again: the provider answered 200.
            assert len(played.responses) == 1

    caplog.set_level(logging.DEBUG, logger="semiont_inference")
    run(scenario())
    (logged,) = errors(caplog)
    assert logged.getMessage() == "OpenAI reported that the generation failed"
    assert {key: vars(logged)[key] for key in ("model", "code")} == {"model": "gpt-x", "code": error.get("code") if error else None}


@pytest.mark.parametrize(
    "answer",
    [Answer(headers={"content-type": "text/html"}, body=b"<html>a gateway's page</html>"), saying(["not", "an", "object"])],
    ids=["not JSON", "JSON that is not an object"],
)
def test_an_answer_that_is_not_a_json_object_is_a_failure_and_not_an_empty_text(answer: Answer) -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
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
        (responded('{"elements":[{"exact":"\\Villiam Crookes"}]}'), "response is not valid JSON (stop_reason: end_turn)"),
        # Cut off by the budget: the same request is cut off the same way again, which the stop reason lets a worker know.
        (cut_off(message(output_text('{"elements":[{"exact":"William Cro'))), "response is not valid JSON (stop_reason: max_tokens)"),
        (responded('[{"exact":"Paris"}]'), "parsed to array, not the object asked for (stop_reason: end_turn)"),
        (responded('{"entities":[]}'), "the object has no `elements` (stop_reason: end_turn)"),
        (responded('{"elements":{}}'), "`elements` parsed to object, not an array (stop_reason: end_turn)"),
    ],
    ids=["an invalid escape", "cut off", "an array with no wrapper", "another wrapper", "a wrapper that holds no array"],
)
def test_a_reply_that_cannot_be_read_as_the_array_raises_and_is_never_an_empty_one(said: Responded, detail: str) -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(said)
            with pytest.raises(StructuredReadError) as unread:
                await driver(played).generate_structured("p", 1000, 0.3, PERSON)
            assert str(unread.value) == f"Structured response could not be read: {detail}"

    run(scenario())


def test_an_empty_array_is_an_answer() -> None:
    # The other half: "the model found nothing" is a result, and does not raise.
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(responded(wrapped()))
            answer = await driver(played).generate_structured("p", 1000, 0.3, PERSON)
            assert answer == StructuredResponse(items=[], stop_reason="end_turn", usage=COUNTED)

    run(scenario())


def test_the_tokens_are_the_providers_on_either_kind_of_generation() -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            # What was written includes what the model spent reasoning out of sight.
            usage = counted(412, 57, reasoning_tokens=40)
            played.script(responded("text", usage=usage), responded(wrapped(), usage=usage))
            client = driver(played)
            told = TokenUsage(input_tokens=412, output_tokens=57)
            assert await client.generate_text("p", 100, 0) == InferenceResponse(text="text", stop_reason="end_turn", usage=told)
            assert await client.generate_structured("p", 100, 0, ELEMENT) == StructuredResponse(
                items=[], stop_reason="end_turn", usage=told
            )

    run(scenario())


@pytest.mark.parametrize(
    "usage", [None, {}, {"input_tokens": 412}, {"output_tokens": 57}], ids=["no usage", "neither", "read alone", "written alone"]
)
def test_no_tokens_are_answered_where_the_provider_did_not_count_both_on_either_kind_of_generation(usage: JsonObject | None) -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(
                Responded(output=[message(output_text("text"))], usage=usage),
                Responded(output=[message(output_text(wrapped()))], usage=usage),
            )
            client = driver(played)
            # Not known is not nothing: a zero would say the call cost nothing.
            assert await client.generate_text("p", 100, 0) == InferenceResponse(text="text", stop_reason="end_turn", usage=None)
            assert await client.generate_structured("p", 100, 0, ELEMENT) == StructuredResponse(
                items=[], stop_reason="end_turn", usage=None
            )

    run(scenario())


def test_a_call_logs_what_the_other_drivers_do_at_the_same_levels(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(responded("hello"), responded(wrapped({"exact": "A"})), responded("not an object"))
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
        "model": "gpt-x",
        "promptLength": 6,
        "maxTokens": 100,
        "temperature": 0.2,
    }
    # The provider's id of the request, for telling one attempt from another in its logs and in ours.
    assert {key: vars(completed)[key] for key in ("model", "textLength", "stopReason", "requestId")} == {
        "model": "gpt-x",
        "textLength": 5,
        "stopReason": "end_turn",
        "requestId": "req_played_1",
    }
    assert {key: vars(structured)[key] for key in ("model", "items", "stopReason", "requestId")} == {
        "model": "gpt-x",
        "items": 1,
        "stopReason": "end_turn",
        "requestId": "req_played_2",
    }
    assert {key: vars(unread)[key] for key in ("model", "textLength", "stopReason")} == {
        "model": "gpt-x",
        "textLength": 13,
        "stopReason": "end_turn",
    }


# ── failures ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("status", "kind", "code", "asked"),
    [
        (408, "invalid_request_error", None, 3),
        (409, "invalid_request_error", None, 3),
        (429, "requests", "rate_limit_exceeded", 3),
        (500, "server_error", None, 3),
        (503, "server_error", "server_is_overloaded", 3),
        (400, "invalid_request_error", "unsupported_parameter", 1),
        (401, "invalid_request_error", "invalid_api_key", 1),
        (403, "invalid_request_error", None, 1),
        (404, "invalid_request_error", "model_not_found", 1),
        (422, "invalid_request_error", None, 1),
    ],
)
def test_a_refused_generation_is_a_provider_status_error_with_the_librarys_failure_as_its_cause(
    status: int, kind: str, code: str | None, asked: int
) -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(*[openai_error(status, kind=kind, code=code, message="what the provider said")] * asked)
            with pytest.raises(ProviderStatusError) as failed:
                await driver(played).generate_text("p", 100, 0)
            cause = failed.value.__cause__
            assert isinstance(cause, openai.APIStatusError)
            # What the library said of it, with the status and the provider's own words in it.
            assert (failed.value.status, str(failed.value)) == (status, cause.message)
            assert str(status) in str(failed.value)
            assert "what the provider said" in str(failed.value)
            # The retries are this driver's choice of two: a refusal the library asks again for is asked three times
            # in all, and any other once.
            assert played.generations == [said_to("gpt-x", "p", 100, temperature=0)] * asked

    run(scenario())


def test_a_refusal_followed_by_an_answer_is_an_answer() -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(
                openai_error(429, kind="requests", code="rate_limit_exceeded", message="the account is over its rate"), responded(wrapped())
            )
            assert (await driver(played).generate_structured("p", 100, 0, ELEMENT)).items == []
            assert len(played.generations) == 2

    run(scenario())


def test_a_provider_that_says_to_wait_longer_than_two_minutes_is_not_asked_again() -> None:
    # The library's rule: it waits as long as the provider says, up to two minutes, and beyond that gives up at once.
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(openai_error(429, kind="requests", code="slow_down", message="slow down", headers={"retry-after": "121"}))
            with pytest.raises(ProviderStatusError) as failed:
                await driver(played).generate_text("p", 100, 0)
            assert failed.value.status == 429
            assert len(played.responses) == 1

    run(scenario())


def test_the_library_waits_as_long_as_the_provider_says_before_it_asks_again_and_otherwise_a_little_longer_each_time() -> None:
    # The waits are the library's: with nothing said, at least 0.375 s and then at least 0.75 s
    # (half a second, then a second, each less up to a quarter).
    def unsaid(status: int) -> Answer:
        return openai_error(status, kind="server_error", code=None, message="overloaded", headers={})

    async def scenario() -> None:
        async with OpenAI() as played:
            said = openai_error(429, kind="requests", code="slow_down", message="slow down", headers={"retry-after": "2"})
            played.script(unsaid(503), unsaid(500), responded("first"), said, responded("second"))
            client = driver(played)
            assert (await hurried(client.generate_text("p", 100, 0))).text == "first"
            assert (await hurried(client.generate_text("p", 100, 0))).text == "second"
            at = [asked.at for asked in played.responses]
            first, second, told = at[1] - at[0], at[2] - at[1], at[4] - at[3]
            # Each is held from below. The loop's clock is moved a quarter of a second at a time here, however long
            # a step really takes, so from above only a wait of the wrong size is refused.
            assert 0.375 <= first < 2, first
            assert 0.75 <= second < 2, second
            assert 2.0 <= told < 4, told

    run(scenario())


def test_a_connection_that_ends_unanswered_is_asked_three_times_and_then_passed_on_as_the_library_reports_it() -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(HANG_UP, HANG_UP, HANG_UP)
            with pytest.raises(openai.APIConnectionError) as ended:
                await hurried(driver(played).generate_text("p", 100, 0))
            # It carries no status: it is the library's failure, and none of those the interface declares.
            assert not hasattr(ended.value, "status")
            assert len(played.generations) == 3

    run(scenario())


def test_a_generation_that_takes_an_hour_is_neither_given_up_nor_asked_a_second_time() -> None:
    # The library's own bound is ten minutes for each read, after which it sends the same request again, twice.
    # This driver states no bound on a read: a generation ends when it is answered, or when its caller cancels it.
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(HOLD)
            call = asyncio.ensure_future(driver(played).generate_text("p", 100, 0))
            await soon(played.arrived("POST", "/v1/responses"))
            await pass_time(3600, step=30)
            assert not call.done()
            assert len(played.responses) == 1
            played.release(saying({"status": "completed", "output": [message(output_text("at last"))], "usage": counted(10, 5)}))
            assert (await soon(call)).text == "at last"
            assert len(played.responses) == 1

    run(scenario())


# ── cancelling ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("structured", [False, True], ids=["text", "structured"])
def test_cancelling_a_generation_ends_its_task_cancelled_and_closes_the_connection(structured: bool) -> None:
    async def scenario() -> None:
        async with OpenAI() as played:
            played.script(HOLD)
            call = asyncio.ensure_future(generation(driver(played), structured))
            await soon(played.arrived("POST", "/v1/responses"))
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
            assert len(played.responses) == 1

    run(scenario())
