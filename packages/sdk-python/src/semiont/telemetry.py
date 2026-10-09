"""What this SDK's transports tell OpenTelemetry (`specs/src/sdk-telemetry/telemetry.json`).

It takes OpenTelemetry's API and nothing more, so every call here does nothing
until the process it runs in installs a provider: an application's own, or
none. What is told is the table's: a span for each frame sent and each
received, a span for each upload and each read, and a count of the emits sent.

Trace context crosses the wire as W3C's `traceparent` and `tracestate`. A
request carries the context it was made in. A frame brings the context it was
sent under, and the span that marks its arrival continues that trace. What is
nobody's to continue is done `untraced`, and begins a trace of its own.
"""

from collections.abc import Generator, Mapping
from contextlib import AbstractContextManager, contextmanager
from typing import Final, assert_never

from opentelemetry import metrics, trace
from opentelemetry.context import Context, attach, detach
from opentelemetry.trace import SpanKind
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from semiont.telemetry_table import BUS_EMIT, BUS_RECV, CONTENT_GET, CONTENT_GET_GRAPH, CONTENT_PUT, SEMIONT_BUS_SENT, SpanKindName, SpanRow
from semiont.transport import TraceContext

__all__ = ["active", "emitting", "getting", "getting_graph", "putting", "received", "trace_headers", "untraced"]

_SCOPE: Final = "semiont"
_TRACER: Final = trace.get_tracer(_SCOPE)
_SENT: Final = metrics.get_meter(_SCOPE).create_counter(SEMIONT_BUS_SENT.name, description="Emits the client sent")
# W3C's, named outright: which propagators a process is configured with is not this SDK's to read.
_W3C: Final = TraceContextTextMapPropagator()
_CHANNEL: Final = "{channel}"

# What an attribute of this SDK's telemetry is.
type _Attribute = str | bool | int


def _kind(name: SpanKindName) -> SpanKind:
    match name:
        case "client":
            return SpanKind.CLIENT
        case "consumer":
            return SpanKind.CONSUMER
        case "producer":
            return SpanKind.PRODUCER
        case _:
            assert_never(name)


@contextmanager
def _span(row: SpanRow, attributes: Mapping[str, _Attribute], *, channel: str = "", parent: Context | None = None) -> Generator[None]:
    """A span of the table, current for as long as it is held."""
    with _TRACER.start_as_current_span(row.name.replace(_CHANNEL, channel), context=parent, kind=_kind(row.kind), attributes=attributes):
        yield


def _on_the_bus(channel: str, scope: str | None) -> dict[str, _Attribute]:
    attributes: dict[str, _Attribute] = {"bus.channel": channel}
    if scope is not None:
        attributes["bus.scope"] = scope
    return attributes


def trace_headers() -> dict[str, str]:
    """The headers that carry the trace a request is made in: none when it is made in none."""
    carrier: dict[str, str] = {}
    _W3C.inject(carrier)
    return carrier


def active() -> TraceContext | None:
    """The trace this code is running in, as the wire carries one."""
    carrier = trace_headers()
    traceparent = carrier.get("traceparent")
    return None if traceparent is None else TraceContext(traceparent=traceparent, tracestate=carrier.get("tracestate") or None)


@contextmanager
def untraced() -> Generator[None]:
    """Hold no trace: what is done while this is held has no parent, whatever span is current around it.

    For work that is nobody's: a worker's claim, which belongs to no job, is
    made here even when the task that makes it began inside the span of the
    job settled before it.
    """
    held = attach(Context())
    try:
        yield
    finally:
        detach(held)


def emitting(channel: str, scope: str | None) -> AbstractContextManager[None]:
    """One emit: counted as sent, and in a span for as long as it is held."""
    attributes = _on_the_bus(channel, scope)
    _SENT.add(1, attributes)
    return _span(BUS_EMIT, attributes, channel=channel)


def received(channel: str, scope: str | None, sent_under: TraceContext | None) -> TraceContext | None:
    """Mark a frame's arrival, in the trace it was sent under.

    Returns the trace the work done for the frame continues: the arrival's
    own span when one was recorded, and what the frame brought otherwise.
    """
    parent: Context | None = None
    if sent_under is not None:
        carrier = {"traceparent": sent_under.traceparent}
        if sent_under.tracestate is not None:
            carrier["tracestate"] = sent_under.tracestate
        parent = _W3C.extract(carrier)
    with _span(BUS_RECV, _on_the_bus(channel, scope), channel=channel, parent=parent):
        return active() or sent_under


def putting(media_type: str, size_bytes: int) -> AbstractContextManager[None]:
    """An upload, in a span for as long as it is held."""
    return _span(CONTENT_PUT, {"content.format": media_type, "content.size_bytes": size_bytes})


def getting(resource_id: str, *, stream: bool) -> AbstractContextManager[None]:
    """A read of a resource's bytes, in a span for as long as it is held."""
    attributes: dict[str, _Attribute] = {"resource.id": resource_id}
    if stream:
        attributes["content.stream"] = True
    return _span(CONTENT_GET, attributes)


def getting_graph(resource_id: str) -> AbstractContextManager[None]:
    """A read of a resource's description, in a span for as long as it is held."""
    return _span(CONTENT_GET_GRAPH, {"resource.id": resource_id})
