"""What the worker tells OpenTelemetry of its work: its rows of `specs/src/service-telemetry/telemetry.json`.

It takes OpenTelemetry's API and nothing more, so recording does nothing
until the process it runs in installs a provider. What a driver records of a
generation, the `semiont.inference.*` rows, is the driver's own.
"""

import time
from collections.abc import Generator
from contextlib import contextmanager
from typing import Final, Literal

from opentelemetry import metrics, trace
from opentelemetry.trace import SpanKind
from semiont.annotations import AnchorMethod
from semiont_inference.interface import TokenUsage

_SCOPE: Final = "semiont"
_TRACER: Final = trace.get_tracer(_SCOPE)
_METER: Final = metrics.get_meter(_SCOPE)
_DETECTION_CALLS: Final = _METER.create_counter(
    "semiont.detection.calls", description="Generations a mark job made, by what asked, outcome, depth of halving and second asking"
)
_DETECTION_CALL_DURATION: Final = _METER.create_histogram(
    "semiont.detection.call.duration", unit="ms", description="How long each generation a mark job made took, the failing ones too"
)
_DETECTION_CALL_ITEMS: Final = _METER.create_histogram(
    "semiont.detection.call.items", description="Proposals each generation a mark job made returned; none for one that failed"
)
_DETECTION_CALL_TOKENS: Final = _METER.create_histogram(
    "semiont.detection.call.tokens", description="Tokens a provider reported for each generation a mark job made, by direction"
)
_DETECTION_ANCHORS: Final = _METER.create_counter(
    "semiont.detection.anchors", description="Spans a mark job anchored in its text, by what was anchored and how each was found"
)

type GenerationKind = Literal["text", "structured"]
"""What a generation is asked for: text, or an array of objects."""

type DetectionLabel = Literal["highlight", "comment", "assessment", "tag", "reference"]
"""Which kind of `mark` job a generation was made for."""

type DetectionOutcome = Literal["success", "truncated", "timeout", "collapsed", "error"]
"""How a generation a `mark` job made ended.

`truncated` is a reply that was cut off, and `collapsed` one that read
cleanly and found a fraction of what a count says is there. The two are told
apart, though a piece that suffers either is asked again in smaller pieces:
one is a reply that overflowed, and the other a silent under-report.
"""


@contextmanager
def generating(kind: GenerationKind, *, provider: str, model: str, max_tokens: int) -> Generator[None]:
    """One generation asked of a provider, in a span for as long as it is held: `inference:text` or `inference:structured`.

    A failure raised while it is held is recorded on the span, which is then
    an error's.
    """
    attributes: dict[str, str | int] = {"inference.provider": provider, "inference.model": model, "inference.max_tokens": max_tokens}
    with _TRACER.start_as_current_span(f"inference:{kind}", kind=SpanKind.INTERNAL, attributes=attributes):
        yield


def record_detection_call(
    *,
    label: DetectionLabel,
    started: float,
    items: int,
    depth: int,
    reroll: bool,
    outcome: DetectionOutcome,
    usage: TokenUsage | None,
) -> None:
    """Count one generation a `mark` job made: the `semiont.detection.call*` rows.

    `started` is when it began, a reading of `time.perf_counter`. A driver
    already records each generation by provider and model. What it cannot
    know is the job around it: what asked, how many proposals came back, how
    many times the piece had been halved (`depth`), and whether this was the
    second asking of a piece too small to halve (`reroll`). A generation that
    failed is counted too: the calls paid for and thrown away in a descent
    are the cost that sizing a piece well avoids.

    `usage` is the provider's count, and is never estimated. A generation its
    provider did not count adds no tokens.
    """
    filed: dict[str, str | int | bool] = {
        "detection.label": label,
        "detection.outcome": outcome,
        "detection.depth": depth,
        "detection.reroll": reroll,
    }
    _DETECTION_CALLS.add(1, filed)
    _DETECTION_CALL_DURATION.record((time.perf_counter() - started) * 1000, filed)
    _DETECTION_CALL_ITEMS.record(items, filed)
    if usage is not None:
        _DETECTION_CALL_TOKENS.record(usage.input_tokens, {**filed, "detection.direction": "input"})
        _DETECTION_CALL_TOKENS.record(usage.output_tokens, {**filed, "detection.direction": "output"})


def record_anchor(label: DetectionLabel, method: AnchorMethod) -> None:
    """Count one span a `mark` job anchored in its text, by how it was found: the `semiont.detection.anchors` row.

    Every anchor is counted, the sure ones too: the doubtful ones are a share
    of them all, and a count of the doubtful alone is a share of nothing.
    """
    _DETECTION_ANCHORS.add(1, {"detection.label": label, "anchor.method": method})
