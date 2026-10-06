"""What the SDK tells OpenTelemetry, held to the table every SDK is held to (`specs/src/sdk-telemetry/telemetry.json`).

The conformance suite holds it from outside, through an exporter. This holds
it here, in memory: every row arrives, of its kind, with the attributes every
one of them carries; nothing arrives under a row's name with an attribute the
row does not list; and a trace crosses the wire in both directions.
"""

import re

import pytest
from aio import run, soon
from gateway_server import GatewayServer
from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader, Sum
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind

from semiont.http import HttpTransport
from semiont.identifiers import ResourceId
from semiont.telemetry_table import METRICS, SPANS, SpanKindName, SpanRow
from semiont.transport import Frame, PutBinaryRequest
from semiont.watched import Variable, reached

KINDS: dict[SpanKindName, SpanKind] = {"client": SpanKind.CLIENT, "consumer": SpanKind.CONSUMER, "producer": SpanKind.PRODUCER}
RESOURCE = ResourceId("res-1")
SENT_UNDER = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"


@pytest.fixture(scope="session")
def exported() -> tuple[InMemorySpanExporter, InMemoryMetricReader]:
    """The process's providers, installed once: what the SDK tells them is kept here."""
    spans = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(spans))
    trace.set_tracer_provider(provider)
    reader = InMemoryMetricReader()
    metrics.set_meter_provider(MeterProvider(metric_readers=[reader]))
    return spans, reader


def of(row: SpanRow, spans: tuple[ReadableSpan, ...]) -> list[ReadableSpan]:
    """The spans that arrived under a row's name."""
    pattern = re.compile(re.escape(row.name).replace(re.escape("{channel}"), ".+"))
    return [span for span in spans if pattern.fullmatch(span.name)]


async def traffic() -> tuple[Frame, str | None]:
    """One of everything the table lists. Returns the frame received, and the trace the emit carried."""
    async with (
        GatewayServer() as gateway,
        HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=("beckon:focus", "beckon:sparkle")) as transport,
    ):
        gateway.stored[RESOURCE] = ("image/png", b"bytes")
        gateway.described[RESOURCE] = {
            "resource": {"@context": "https://schema.org/", "@id": "res-1", "name": "n", "representations": []},
            "annotations": [],
            "entityReferences": [],
        }
        await soon(reached(transport.state, lambda state: state == "open"))
        frames = transport.frames("beckon:focus")
        gateway.send(
            "e-1", {"channel": "beckon:focus", "scope": "res-1", "payload": {"annotationId": "a-1", "_trace": {"traceparent": SENT_UNDER}}}
        )
        frame = await soon(anext(frames))
        await transport.emit("beckon:sparkle", {"annotationId": "a-2"})
        await transport.emit("beckon:sparkle", {"annotationId": "a-3"}, scope=RESOURCE)
        await transport.content.put_binary(PutBinaryRequest(name="n", file=b"12345", format="image/png", storage_uri="file://n"))
        await transport.content.get_binary(RESOURCE)
        async with await transport.content.get_binary_stream(RESOURCE) as stream:
            _ = [piece async for piece in stream]
        await transport.content.get_resource_graph(RESOURCE)
        return frame, gateway.of("POST", "/bus/emit")[0].headers.get("traceparent")


def test_what_is_exported_is_what_the_table_lists(exported: tuple[InMemorySpanExporter, InMemoryMetricReader]) -> None:
    exporter, reader = exported
    exporter.clear()
    frame, carried = run(traffic())
    spans = exporter.get_finished_spans()

    for row in SPANS:
        arrived = of(row, spans)
        assert arrived, f"no {row.name} span"
        for span in arrived:
            keys = set(span.attributes or {})
            assert span.kind is KINDS[row.kind], f"{span.name} is of kind {span.kind}"
            assert keys <= set(row.attributes), f"{span.name} carries {keys - set(row.attributes)}, which the table does not list"
            assert set(row.always) <= keys, f"{span.name} lacks {set(row.always) - keys}"
    listed = [span for row in SPANS for span in of(row, spans)]
    assert sorted(span.name for span in spans) == sorted(span.name for span in listed), "a span no row names"
    # What an attribute marked `only` is for is seen at least once: a scope, and a read taken as a stream.
    assert {key for span in spans for key in span.attributes or {}} == {key for row in SPANS for key in row.attributes}

    data = reader.get_metrics_data()
    assert data is not None
    arrived_metrics = {
        metric.name: metric for resource in data.resource_metrics for scope in resource.scope_metrics for metric in scope.metrics
    }
    for metric_row in METRICS:
        metric = arrived_metrics[metric_row.name]
        assert isinstance(metric.data, Sum)
        assert metric.data.is_monotonic, f"{metric_row.name} is not a {metric_row.instrument}"
        for point in metric.data.data_points:
            keys = set(point.attributes or {})
            assert keys <= set(metric_row.attributes)
            assert set(metric_row.always) <= keys

    # A frame continues the trace it was sent under: its arrival is a span of that trace, and its reader is handed the span's context.
    (arrival,) = of(SPANS[1], spans)
    assert arrival.context is not None
    assert arrival.parent is not None
    assert f"{arrival.context.trace_id:032x}" == SENT_UNDER.split("-")[1]
    assert f"{arrival.parent.span_id:016x}" == SENT_UNDER.split("-")[2]
    assert frame.payload == {"annotationId": "a-1"}, "the trace a frame was sent under is beside its payload, never inside it"
    assert frame.trace is not None
    assert frame.trace.traceparent.split("-")[1:3] == [SENT_UNDER.split("-")[1], f"{arrival.context.span_id:016x}"]

    # An emit carries the trace it is made in: the gateway is told the span it was sent in.
    sent = next(span for span in of(SPANS[0], spans) if "bus.scope" not in (span.attributes or {}))
    assert sent.context is not None
    assert carried is not None
    assert carried.split("-")[1:3] == [f"{sent.context.trace_id:032x}", f"{sent.context.span_id:016x}"]


def test_the_emits_sent_are_counted(exported: tuple[InMemorySpanExporter, InMemoryMetricReader]) -> None:
    _, reader = exported

    def sent() -> int:
        data = reader.get_metrics_data()
        if data is None:
            return 0
        total = 0
        for resource in data.resource_metrics:
            for scope in resource.scope_metrics:
                for metric in scope.metrics:
                    if metric.name == METRICS[0].name and isinstance(metric.data, Sum):
                        total += sum(int(point.value) for point in metric.data.data_points)
        return total

    before = sent()
    run(traffic())
    assert sent() - before == 2
