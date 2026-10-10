"""What a driver tells OpenTelemetry of a generation: the `semiont.inference.*` rows of `specs/src/service-telemetry/telemetry.json`.

It takes OpenTelemetry's API and nothing more, so recording does nothing
until the process it runs in installs a provider.
"""

import time
from typing import Final, Literal

from opentelemetry import metrics

_METER: Final = metrics.get_meter("semiont")
_CALLS: Final = _METER.create_counter("semiont.inference.calls", description="Inference API calls by provider, model, and outcome")
_TOKENS: Final = _METER.create_counter("semiont.inference.tokens", description="Inference token usage by provider, model, and direction")
_DURATION: Final = _METER.create_histogram(
    "semiont.inference.duration", unit="ms", description="Inference call duration by provider, model, and outcome"
)


def record(
    *,
    provider: str,
    model: str,
    started: float,
    outcome: Literal["success", "error"],
    input_tokens: int | None,
    output_tokens: int | None,
) -> None:
    """Count one generation that began at `started` (a reading of `time.perf_counter`), by how it ended, and how long it took.

    Its tokens are counted where the provider reported them. A provider that
    reports none, and a call that failed before anything was generated, add
    none.
    """
    ended = {"inference.provider": provider, "inference.model": model, "inference.outcome": outcome}
    _CALLS.add(1, ended)
    _DURATION.record((time.perf_counter() - started) * 1000, ended)
    for direction, count in (("input", input_tokens), ("output", output_tokens)):
        if count is not None and count > 0:
            _TOKENS.add(count, {"inference.provider": provider, "inference.model": model, "inference.direction": direction})
