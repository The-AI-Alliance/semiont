"""What the drivers tell OpenTelemetry, held to the table every service is held to (`specs/src/service-telemetry/telemetry.json`).

The three `semiont.inference.*` rows are read from the table, and compared
with what an in-memory reader collected from real calls of both drivers: the
names, the kind of instrument, the attribute keys, and the values a row
lists. A row that changes fails here.
"""

import asyncio

import pytest
from aio import run, soon
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import (
    ExponentialHistogramDataPoint,
    Histogram,
    HistogramDataPoint,
    InMemoryMetricReader,
    Metric,
    NumberDataPoint,
    Sum,
)
from provider import HOLD, Anthropic, Ollama, generated, refused, reply, saying
from spec import SPEC, JsonObject, objects, read, strings, text

from semiont_inference.anthropic import AnthropicInferenceClient
from semiont_inference.interface import ProviderStatusError, StructuredReadError
from semiont_inference.ollama import OllamaInferenceClient

# Models no other test names: the reader keeps what the whole run recorded.
LLAMA, CLAUDE = "telemetry-llama", "telemetry-claude"
ELEMENT: JsonObject = {"type": "object"}
PREFIX = "semiont.inference."


@pytest.fixture(scope="session")
def arrived() -> dict[str, Metric]:
    """Every inference metric recorded, by name, once the traffic has run. The process's meter provider is installed here, once."""
    reader = InMemoryMetricReader()
    metrics.set_meter_provider(MeterProvider(metric_readers=[reader]))
    run(traffic())
    data = reader.get_metrics_data()
    assert data is not None
    return {
        metric.name: metric
        for resource in data.resource_metrics
        for scope in resource.scope_metrics
        for metric in scope.metrics
        if metric.name.startswith(PREFIX)
    }


async def traffic() -> None:
    """Generations of each driver that end each way a row lists."""
    async with Ollama() as ollama, Anthropic() as played:
        ollama.script(
            generated("hello", prompt_eval_count=412, eval_count=57),
            # Its provider reports no tokens: it is counted as a call, and adds none.
            generated("hello"),
            saying({"error": "busy"}, status=500),
            # Empty, and still counted by the provider: the tokens were spent.
            generated("", prompt_eval_count=3, eval_count=9),
            HOLD,
        )
        llama = OllamaInferenceClient(model=LLAMA, base_url=ollama.origin)
        await llama.generate_text("p", 100, 0)
        await llama.generate_text("p", 100, 0)
        with pytest.raises(ProviderStatusError):
            await llama.generate_text("p", 100, 0)
        with pytest.raises(StructuredReadError):
            await llama.generate_text("p", 100, 0)
        # A generation its caller cancelled ended, and not well.
        cancelled = asyncio.ensure_future(llama.generate_text("p", 100, 0))
        await soon(ollama.arrived("POST", "/api/generate", 5))
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled

        played.script(
            reply("hello", usage={"input_tokens": 4127, "output_tokens": 571}),
            reply("not an array", usage={"input_tokens": 10, "output_tokens": 5}),
            # Nothing in it, and still counted by the provider.
            reply("", stop_reason="max_tokens", usage={"input_tokens": 7, "output_tokens": 3}),
            refused(400, "invalid_request_error", "max_tokens: the model writes fewer"),
        )
        claude = AnthropicInferenceClient(api_key="k", model=CLAUDE, base_url=played.origin)
        await claude.generate_text("p", 100, 0)
        with pytest.raises(StructuredReadError):
            await claude.generate_structured("p", 100, 0, ELEMENT)
        with pytest.raises(StructuredReadError):
            await claude.generate_text("p", 100, 0)
        with pytest.raises(ProviderStatusError):
            await claude.generate_text("p", 100, 0)


def ours(metric: Metric) -> list[NumberDataPoint | HistogramDataPoint | ExponentialHistogramDataPoint]:
    """The points of `metric` that this test's traffic made."""
    return [point for point in metric.data.data_points if (point.attributes or {}).get("inference.model") in (LLAMA, CLAUDE)]


def test_what_the_drivers_record_is_what_the_table_lists(arrived: dict[str, Metric]) -> None:
    rows = {text(row["name"], "a name"): row for row in objects(read(SPEC / "service-telemetry/telemetry.json")["metrics"], "the metrics")}
    listed = {name: row for name, row in rows.items() if name.startswith(PREFIX)}
    assert listed, "the table lists no inference metric: this gate reads nothing"
    assert set(arrived) == set(listed)

    for name, row in listed.items():
        metric = arrived[name]
        match text(row["instrument"], "an instrument"):
            case "counter":
                assert isinstance(metric.data, Sum), f"{name} is not a counter"
                assert metric.data.is_monotonic, f"{name} is not a counter"
            case "histogram":
                assert isinstance(metric.data, Histogram), f"{name} is not a histogram"
            case other:
                raise AssertionError(f"{name} is listed as a {other}, which this test does not know how to hold")
        attributes = objects(row["attributes"], "the attributes")
        keys = {text(attribute["key"], "a key") for attribute in attributes}
        points = ours(metric)
        assert points, f"no {name} was recorded"
        for point in points:
            assert set(point.attributes or {}) == keys, f"{name} carries {set(point.attributes or {})}; the table lists {keys}"
        for attribute in attributes:
            if "values" in attribute:
                seen = {str((point.attributes or {})[text(attribute["key"], "a key")]) for point in points}
                assert seen == set(strings(attribute["values"], "the values")), f"{name}: {attribute['key']} was {seen}"


def test_a_generation_is_counted_once_by_how_it_ended_and_its_tokens_are_the_providers(arrived: dict[str, Metric]) -> None:
    calls: dict[tuple[object, object], float] = {}
    for point in ours(arrived["semiont.inference.calls"]):
        assert isinstance(point, NumberDataPoint)
        attributes = point.attributes or {}
        calls[attributes["inference.provider"], attributes["inference.outcome"]] = point.value
    tokens: dict[tuple[object, object], float] = {}
    for point in ours(arrived["semiont.inference.tokens"]):
        assert isinstance(point, NumberDataPoint)
        attributes = point.attributes or {}
        tokens[attributes["inference.provider"], attributes["inference.direction"]] = point.value
    timed: dict[tuple[object, object], int] = {}
    for point in ours(arrived["semiont.inference.duration"]):
        assert isinstance(point, HistogramDataPoint)
        attributes = point.attributes or {}
        timed[attributes["inference.provider"], attributes["inference.outcome"]] = point.count

    assert calls == {("ollama", "success"): 2, ("ollama", "error"): 3, ("anthropic", "success"): 1, ("anthropic", "error"): 3}
    # What the provider counted, and nothing else: not the probe's tokens, and nothing for a call whose provider reported none.
    assert tokens == {
        ("ollama", "input"): 412 + 3,
        ("ollama", "output"): 57 + 9,
        ("anthropic", "input"): 4127 + 10 + 7,
        ("anthropic", "output"): 571 + 5 + 3,
    }
    # Every generation is timed, the failing ones too, in milliseconds.
    assert timed == calls
    assert arrived["semiont.inference.duration"].unit == "ms"
