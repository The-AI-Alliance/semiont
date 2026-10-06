# Generated from specs/src/sdk-telemetry/telemetry.json; do not edit.
# Regenerate: node scripts/spec/generate-sdk-telemetry-python.mjs

"""The telemetry a Semiont SDK's transports export, when the process they run
in exports at all: every span and metric, its kind, and the attributes it
carries.

The table is every SDK's: the conformance suite holds each to it from outside.
A span's name may hold `{channel}`, which stands for the bus channel.
"""

from dataclasses import dataclass
from typing import Final, Literal, final

__all__ = [
    "BUS_EMIT",
    "BUS_RECV",
    "CONTENT_GET",
    "CONTENT_GET_GRAPH",
    "CONTENT_PUT",
    "Instrument",
    "METRICS",
    "MetricRow",
    "SEMIONT_BUS_SENT",
    "SPANS",
    "SpanKindName",
    "SpanRow",
]

# The kinds of span the table states, by OTLP's names for them.
type SpanKindName = Literal["client", "consumer", "producer"]

# The instruments the table states.
type Instrument = Literal["counter"]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class SpanRow:
    """A span an SDK exports."""

    name: str
    kind: SpanKindName
    attributes: tuple[str, ...]
    """Every attribute it may carry. It carries no other."""
    always: tuple[str, ...]
    """The attributes every one of them carries."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class MetricRow:
    """A metric an SDK exports."""

    name: str
    instrument: Instrument
    attributes: tuple[str, ...]
    """Every attribute a data point of it may carry. It carries no other."""
    always: tuple[str, ...]
    """The attributes every data point of it carries."""


# A frame the client sent, in the trace of the work that sent it.
BUS_EMIT: Final = SpanRow(
    name="bus.emit:{channel}",
    kind="producer",
    attributes=("bus.channel", "bus.scope"),
    always=("bus.channel",),
)

# A frame the client received, and the work done for it, in the trace the frame was sent under.
BUS_RECV: Final = SpanRow(
    name="bus.recv:{channel}",
    kind="consumer",
    attributes=("bus.channel", "bus.scope"),
    always=("bus.channel",),
)

# An upload.
CONTENT_PUT: Final = SpanRow(
    name="content.put",
    kind="client",
    attributes=("content.format", "content.size_bytes"),
    always=("content.format", "content.size_bytes"),
)

# A read of a resource's bytes.
CONTENT_GET: Final = SpanRow(
    name="content.get",
    kind="client",
    attributes=("resource.id", "content.stream"),
    always=("resource.id",),
)

# A read of a resource's description.
CONTENT_GET_GRAPH: Final = SpanRow(
    name="content.get_graph",
    kind="client",
    attributes=("resource.id",),
    always=("resource.id",),
)

# Emits the client sent.
SEMIONT_BUS_SENT: Final = MetricRow(
    name="semiont.bus.sent",
    instrument="counter",
    attributes=("bus.channel", "bus.scope"),
    always=("bus.channel",),
)

SPANS: Final[tuple[SpanRow, ...]] = (
    BUS_EMIT,
    BUS_RECV,
    CONTENT_PUT,
    CONTENT_GET,
    CONTENT_GET_GRAPH,
)

METRICS: Final[tuple[MetricRow, ...]] = (
    SEMIONT_BUS_SENT,
)
