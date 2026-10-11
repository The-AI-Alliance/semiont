"""Where the process's telemetry goes, and the readings the process takes of itself.

The environment says whether anything is exported, and where
(`docs/protocol/WEAVER.md` § Environment). With a collector's endpoint, spans
and metrics are exported there over OTLP/HTTP. With the console exporter
instead, they are written to the process's output. With neither, or with the
SDK disabled, nothing is installed: every span the process's code makes then
goes nowhere, and no trace context travels.

What is installed is the process's: OpenTelemetry's API reports to it, so the
spans the SDK makes of every frame the Weaver sends and receives are exported
with no word from the Weaver. The endpoint and the service's name are read
here and handed to OpenTelemetry's SDK, and the resource is the two attributes
stated here, so that no other variable changes what the telemetry table
promises of the service. That SDK reads the standard variables it reads on its
own, such as how long a finished span waits to be exported.

OpenTelemetry's SDK and its exporter are imported when something is exported,
and not before: a process that exports nothing does not load them.

The code of this module is the Worker service's
(`apps/worker/src/semiont_worker/observability.py`), under the Weaver's name:
`tests/test_census.py` holds the two to one another, and the Worker's tests
hold what it does.
"""

import asyncio
import math
import sys
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from importlib.metadata import version
from pathlib import Path
from typing import Final, final

from opentelemetry import metrics, trace
from opentelemetry.metrics import CallbackOptions, Meter, Observation

from semiont_weaver.config import set_in

_SERVICE_NAME: Final = "semiont-weaver"
"""The name the service's telemetry is exported under, unless its environment states another."""

_METRIC_EXPORT_INTERVAL_MS: Final = 30_000
"""How often metrics are exported, unless the environment states another interval."""

_SHUTDOWN_SECONDS: Final = 2.0
"""How long the last export is given when the process stops: a collector that does not answer does not hold the process open."""

_LAG_RESOLUTION_SECONDS: Final = 0.010
"""How long the loop is asked to sleep, each time its lateness is measured."""

_LAG_WINDOW_SAMPLES: Final = 100_000
"""The most samples of the loop's lateness kept between two exports."""


@final
class Lag:
    """How late the loop woke a task that asked to sleep, since the readings were last taken: time the process could not serve anything."""

    def __init__(self) -> None:
        self._samples: list[float] = []
        self._taking: Final = threading.Lock()

    def note(self, late_ms: float) -> None:
        with self._taking:
            if len(self._samples) < _LAG_WINDOW_SAMPLES:
                self._samples.append(late_ms)

    def observed(self, _: CallbackOptions) -> Iterable[Observation]:
        """The mean, the 99th percentile and the most of what was measured since this was last asked, in milliseconds."""
        with self._taking:
            samples, self._samples = sorted(self._samples), []
        if not samples:
            return []
        p99 = samples[math.ceil(len(samples) * 99 / 100) - 1]
        return [
            Observation(sum(samples) / len(samples), {"lag.stat": "mean"}),
            Observation(p99, {"lag.stat": "p99"}),
            Observation(samples[-1], {"lag.stat": "max"}),
        ]


def _status_bytes(name: str) -> int | None:
    """What the kernel's account of this process says under `name`, in bytes. Nothing where there is no such account, or no such line."""
    try:
        status = Path("/proc/self/status").read_text(encoding="ascii")
    except OSError:
        return None
    for line in status.splitlines():
        if line.startswith(name):
            stated = line.removeprefix(name).strip().removesuffix("kB").strip()
            return int(stated) * 1024 if stated.isascii() and stated.isdigit() else None
    return None


def _memory_limit() -> int | None:
    """The memory the process may use before it is killed: its control group's limit. Nothing where none is set."""
    for stated in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            limit = Path(stated).read_text(encoding="ascii").strip()
        except OSError:
            continue
        if limit.isascii() and limit.isdigit() and int(limit) < 2**62:
            return int(limit)
    return None


def memory(_: CallbackOptions) -> Iterable[Observation]:
    """The process's memory by kind: what it has reserved for data, what it is allowed, and what is resident.

    Each is read from the kernel and said only where it could be read. How
    much of its heap the interpreter has in use is not among them: Python
    keeps no such count.
    """
    readings = (("total", _status_bytes("VmData:")), ("limit", _memory_limit()), ("rss", _status_bytes("VmRSS:")))
    return [Observation(reading, {"heap.stat": kind}) for kind, reading in readings if reading is not None]


def lives_less_one(events: str, name: str) -> Callable[[CallbackOptions], Iterable[Observation]]:
    """What reads how many times the supervisor has restarted the service: the lives its events log records, less one."""
    marker = f"starting {name}"

    def restarts(_: CallbackOptions) -> Iterable[Observation]:
        try:
            log = Path(events).read_text(encoding="utf-8", errors="replace")
        except OSError:
            # The log cannot be read just now. Nothing is said, and never nought: nought is what a healthy service reports.
            return []
        return [Observation(max(0, sum(marker in line for line in log.splitlines()) - 1))]

    return restarts


@final
class Exporting:
    """The process's telemetry while it is exported: what samples the loop, and what sends the last of it."""

    def __init__(self, lag: Lag, end: Callable[[], None]) -> None:
        self._lag: Final = lag
        self._end: Final = end
        self._abnormal_exits: Final = metrics.get_meter("semiont").create_counter(
            "semiont.process.abnormal_exit", description="Process terminations that were not a clean shutdown"
        )

    async def sample_the_loop(self) -> None:
        """Measure how late the loop wakes a sleeping task, for as long as this is awaited."""
        loop = asyncio.get_running_loop()
        while True:
            asked = loop.time()
            await asyncio.sleep(_LAG_RESOLUTION_SECONDS)
            self._lag.note(max(0.0, loop.time() - asked - _LAG_RESOLUTION_SECONDS) * 1000)

    def died(self) -> None:
        """Count a failure nothing caught, just before the process exits for it."""
        self._abnormal_exits.add(1, {"reason": "uncaughtException"})

    def shutdown(self) -> None:
        """Export what is buffered and stop, within two seconds."""
        ending = threading.Thread(target=self._end, daemon=True)
        ending.start()
        ending.join(_SHUTDOWN_SECONDS)


def interval_ms(environment: Mapping[str, str]) -> int:
    """The milliseconds between metric exports: what the environment states, where that is a whole number above nought."""
    stated = (set_in(environment, "OTEL_METRIC_EXPORT_INTERVAL") or "").strip()
    if stated.isascii() and stated.isdigit() and int(stated) > 0:
        return int(stated)
    return _METRIC_EXPORT_INTERVAL_MS


def report_the_process(meter: Meter, lag: Lag, environment: Mapping[str, str]) -> None:
    """Register the readings every Semiont service takes of itself: when it started, how late its loop runs, and its memory."""
    started = int(time.time())
    meter.create_observable_gauge(
        "semiont.process.start_time",
        callbacks=[lambda _: [Observation(started)]],
        unit="s",
        description="Unix seconds at which this process started; a change means it restarted",
    )
    meter.create_observable_gauge(
        "semiont.runtime.event_loop.lag",
        callbacks=[lag.observed],
        unit="ms",
        description="How late the loop woke a sleeping task, over the last export interval. Time the process could not serve anything.",
    )
    meter.create_observable_gauge(
        "semiont.runtime.heap",
        callbacks=[memory],
        unit="By",
        description="Process memory by kind: reserved for data, the control group's limit, and resident.",
    )
    # Under a supervisor alone. Unsupervised, the gauge does not exist: one that read nought would say a healthy supervised service.
    events, name = set_in(environment, "SUPERVISE_EVENTS"), set_in(environment, "SUPERVISE_NAME")
    if events is not None and name is not None:
        meter.create_observable_gauge(
            "semiont.process.restarts",
            callbacks=[lives_less_one(events, name)],
            description="Times the supervisor has restarted this service",
        )


def install(environment: Mapping[str, str]) -> Exporting | None:
    """Start exporting the process's telemetry as `environment` says, or do nothing where it says to export none.

    Called once, before anything the process does is to be told.
    """
    if environment.get("OTEL_SDK_DISABLED") == "true":
        return None
    endpoint = set_in(environment, "OTEL_EXPORTER_OTLP_ENDPOINT")
    if endpoint is None and environment.get("OTEL_CONSOLE_EXPORTER") != "true":
        return None

    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import ConsoleMetricExporter, MetricExporter, PeriodicExportingMetricReader
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter, SpanExporter

    resource = Resource(
        {"service.name": set_in(environment, "OTEL_SERVICE_NAME") or _SERVICE_NAME, "service.version": version("semiont-weaver")}
    )

    spans: SpanExporter = ConsoleSpanExporter(out=sys.stdout)
    if endpoint is not None:
        spans = OTLPSpanExporter(endpoint=f"{endpoint.removesuffix('/')}/v1/traces")
    # Neither provider ends itself when the interpreter does: the process ends them, within a bound (`Exporting.shutdown`).
    tracers = TracerProvider(resource=resource, shutdown_on_exit=False)
    tracers.add_span_processor(BatchSpanProcessor(spans))

    # Spans follow the endpoint. Metrics are also written to the output when the environment asks for that alone.
    measures: MetricExporter = ConsoleMetricExporter(out=sys.stdout)
    if endpoint is not None and environment.get("OTEL_METRICS_EXPORTER") != "console":
        measures = OTLPMetricExporter(endpoint=f"{endpoint.removesuffix('/')}/v1/metrics")
    meters = MeterProvider(
        resource=resource,
        metric_readers=[PeriodicExportingMetricReader(measures, export_interval_millis=interval_ms(environment))],
        shutdown_on_exit=False,
    )

    trace.set_tracer_provider(tracers)
    metrics.set_meter_provider(meters)

    lag = Lag()
    report_the_process(metrics.get_meter("semiont"), lag, environment)

    def end() -> None:
        tracers.shutdown()
        meters.shutdown()

    return Exporting(lag, end)
