"""What the process exports of itself: when it exports nothing, and the readings it takes of itself.

§ Environment of each service's page of `docs/protocol` states what each
variable does, and that service's conformance suite holds a started service
to it, exporter by exporter. A process installs its telemetry once, so what
is installed is those suites' to hold. Here is what is decided before
anything is installed, and each reading, held to the rows of
`specs/src/service-telemetry/telemetry.json` that every service exports. And
here is how a number a service reads of what it keeps is reported as a gauge:
when it is read, and what the gauge says between two reads.
"""

import asyncio
import threading
import time
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest
from aio import pass_time, run, under_way
from counted import counted
from opentelemetry.metrics import CallbackOptions
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import Gauge, InMemoryMetricReader, Metric, NumberDataPoint
from telemetry_rows import MetricRow, as_the_table_writes, metrics_named

from semiont_service.observability import Exporting, Lag, install, interval_ms, lives_less_one, memory, report_the_process


def exported(environment: Mapping[str, str], lag: Lag) -> dict[str, Metric]:
    """What a process reports of itself in `environment`, read once: each metric by its name."""
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader], shutdown_on_exit=False)
    report_the_process(provider.get_meter("semiont"), lag, environment)
    data = reader.get_metrics_data()
    provider.shutdown()
    if data is None:
        return {}
    return {metric.name: metric for resource in data.resource_metrics for scope in resource.scope_metrics for metric in scope.metrics}


def points(metric: Metric) -> Sequence[NumberDataPoint]:
    assert isinstance(metric.data, Gauge), f"{metric.name} is no gauge"
    read: list[NumberDataPoint] = []
    for point in metric.data.data_points:
        assert isinstance(point, NumberDataPoint)
        read.append(point)
    return read


def reported(reader: InMemoryMetricReader, name: str) -> list[Metric]:
    """The metric `name` as the process reports it when read now. Empty where it reports nothing: a gauge with no point is left out."""
    data = reader.get_metrics_data()
    if data is None:
        return []
    return [
        metric
        for resource in data.resource_metrics
        for scope in resource.scope_metrics
        for metric in scope.metrics
        if metric.name == name
    ]


def numbers(reader: InMemoryMetricReader, name: str) -> list[float]:
    """What the gauge `name` reports when it is read now: the number of each of its points."""
    return [point.value for metric in reported(reader, name) for point in points(metric)]


def held_to(row: MetricRow, metric: Metric) -> None:
    """Hold what a gauge carries to its row of the table: its kind, and the keys and values of every point."""
    assert row.instrument == "gauge"
    listed = {attribute.key: attribute.values for attribute in row.attributes}
    for point in points(metric):
        attributes = point.attributes or {}
        assert sorted(attributes) == sorted(listed), f"a point of {metric.name} carries {sorted(attributes)}"
        for key, value in attributes.items():
            values = listed[key]
            assert values is None or as_the_table_writes(value) in values, f"{metric.name} carries {key}={value!r}"


# ── when nothing is exported ────────────────────────────────────────────


@pytest.mark.parametrize(
    "environment",
    [
        {},
        {"OTEL_EXPORTER_OTLP_ENDPOINT": ""},
        {"OTEL_CONSOLE_EXPORTER": "false"},
        {"OTEL_CONSOLE_EXPORTER": "1"},
        {"OTEL_METRICS_EXPORTER": "console"},
        {"OTEL_SERVICE_NAME": "renamed", "OTEL_METRIC_EXPORT_INTERVAL": "500"},
        {"OTEL_SDK_DISABLED": "true", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318"},
        {"OTEL_SDK_DISABLED": "true", "OTEL_CONSOLE_EXPORTER": "true"},
    ],
)
def test_with_no_endpoint_and_no_console_exporter_or_with_the_sdk_disabled_nothing_is_installed(environment: dict[str, str]) -> None:
    assert install("worker", environment) is None


# ── how often metrics are exported ──────────────────────────────────────


@pytest.mark.parametrize(
    ("stated", "milliseconds"),
    [
        (None, 30_000),
        ("", 30_000),
        ("500", 500),
        (" 2500 ", 2500),
        ("0", 30_000),
        ("-500", 30_000),
        ("1.5", 30_000),
        ("soon", 30_000),
        # Digits, and not the ones a number is written in here.
        ("\u0665\u0660\u0660", 30_000),
    ],
)
def test_metrics_are_exported_as_often_as_the_environment_states_and_every_thirty_seconds_where_it_states_no_whole_number_above_nought(
    stated: str | None, milliseconds: int
) -> None:
    environment = {} if stated is None else {"OTEL_METRIC_EXPORT_INTERVAL": stated}
    assert interval_ms(environment) == milliseconds


# ── the readings ────────────────────────────────────────────────────────


def test_a_process_reports_when_it_started_how_late_its_loop_runs_and_its_memory_each_as_the_table_lists_it() -> None:
    lag = Lag()
    for late in (0.0, 1.0, 4.0):
        lag.note(late)
    metrics = exported({}, lag)
    rows = {**metrics_named("semiont.process."), **metrics_named("semiont.runtime.")}
    assert sorted(metrics) == ["semiont.process.start_time", "semiont.runtime.event_loop.lag", "semiont.runtime.heap"]
    for name, metric in metrics.items():
        held_to(rows[name], metric)

    (started,) = points(metrics["semiont.process.start_time"])
    assert isinstance(started.value, int)
    assert started.value > 1_700_000_000

    lateness = {(point.attributes or {})["lag.stat"]: point.value for point in points(metrics["semiont.runtime.event_loop.lag"])}
    assert lateness == {"mean": pytest.approx(5 / 3), "p99": 4.0, "max": 4.0}


def test_the_loop_s_lateness_is_of_what_was_measured_since_it_was_last_read() -> None:
    lag = Lag()
    options = CallbackOptions()
    # Nothing measured is nothing said, and never nought: nought is a loop that was never late.
    assert list(lag.observed(options)) == []
    for late in range(1, 201):
        lag.note(float(late))
    read = {(observation.attributes or {})["lag.stat"]: observation.value for observation in lag.observed(options)}
    assert read == {"mean": 100.5, "p99": 198.0, "max": 200.0}
    assert list(lag.observed(options)) == []


def test_the_loop_s_lateness_is_how_long_past_its_ten_milliseconds_a_sleep_woke() -> None:
    async def scenario() -> None:
        lag = Lag()
        sampling = await under_way(Exporting(lag, lambda: None, 30_000).sample_the_loop())
        # The clock is moved a quarter of a second while the loop is asked to sleep ten milliseconds: each waking is late.
        await pass_time(1.0, step=0.25)
        sampling.cancel()
        await asyncio.gather(sampling, return_exceptions=True)
        read = {(observation.attributes or {})["lag.stat"]: observation.value for observation in lag.observed(CallbackOptions())}
        assert read["max"] == pytest.approx(240.0, abs=1.0)
        assert 0 < read["mean"] <= read["p99"] <= read["max"]

    run(scenario())


def test_memory_is_said_by_kind_as_the_kernel_states_it_and_only_where_it_could_be_read() -> None:
    read = {(observation.attributes or {})["heap.stat"]: observation.value for observation in memory(CallbackOptions())}
    # What the interpreter has in use of its heap is not among them: Python keeps no such count.
    assert set(read) <= {"total", "limit", "rss"}
    if Path("/proc/self/status").exists():
        assert {"total", "rss"} <= set(read)
        assert 1_000_000 < read["rss"] < 2**40
    for value in read.values():
        assert isinstance(value, int)
        assert value > 0


def test_under_a_supervisor_a_process_reports_the_lives_its_log_records_less_one(tmp_path: Path) -> None:
    events = tmp_path / "events.log"

    def life(n: int, name: str = "worker") -> str:
        return f"[supervise 2026-09-30T00:00:0{n}Z] starting {name} (rapid failures so far: {n})"

    supervised = {"SUPERVISE_EVENTS": str(events), "SUPERVISE_NAME": "worker"}
    restarts = "semiont.process.restarts"
    (row,) = metrics_named(restarts).values()

    # One life is no restart, and another service's lives are not this one's.
    events.write_text("\n".join([life(0), life(1, "gateway"), "something else"]) + "\n", encoding="utf-8")
    metric = exported(supervised, Lag())[restarts]
    held_to(row, metric)
    assert [point.value for point in points(metric)] == [0]

    events.write_text("\n".join([life(0), life(1), life(2)]) + "\n", encoding="utf-8")
    assert [point.value for point in points(exported(supervised, Lag())[restarts])] == [2]

    # A log with no life of this service in it is read as none, and not as fewer than none.
    events.write_text("", encoding="utf-8")
    assert [point.value for point in points(exported(supervised, Lag())[restarts])] == [0]


def test_a_log_that_cannot_be_read_says_nothing_and_never_nought(tmp_path: Path) -> None:
    read = lives_less_one(str(tmp_path / "absent.log"), "worker")
    assert list(read(CallbackOptions())) == []


@pytest.mark.parametrize(
    "environment",
    [{}, {"SUPERVISE_EVENTS": "/tmp/events.log"}, {"SUPERVISE_NAME": "worker"}, {"SUPERVISE_EVENTS": "", "SUPERVISE_NAME": "worker"}],
)
def test_without_either_of_the_supervisor_s_two_variables_the_restarts_do_not_exist(environment: dict[str, str]) -> None:
    assert "semiont.process.restarts" not in exported(environment, Lag())


# ── a number a service reads of what it keeps ───────────────────────────


def test_a_number_a_service_samples_is_reported_as_last_read_and_not_at_all_where_the_last_read_answered_none(
    metric_reader: InMemoryMetricReader,
) -> None:
    # The one row of the table that is such a number: the Smelter's count of the points its index holds.
    (row,) = metrics_named("semiont.vector.index.size").values()

    async def scenario() -> None:
        answers = iter([3, 5, None, 8])

        async def read() -> int | None:
            return next(answers)

        exporting = Exporting(Lag(), lambda: None, 60_000)
        sampling = await under_way(exporting.sample(row.name, read, description="Points the index holds"))
        # Read at once. What was read is reported at every export until it is read again.
        (metric,) = reported(metric_reader, row.name)
        held_to(row, metric)
        assert numbers(metric_reader, row.name) == [3]
        assert numbers(metric_reader, row.name) == [3]
        await pass_time(60.0, step=10.0)
        assert numbers(metric_reader, row.name) == [5]
        # A read that answered no number: nothing is reported, and never the number read before it.
        await pass_time(60.0, step=10.0)
        assert numbers(metric_reader, row.name) == []
        await pass_time(60.0, step=10.0)
        assert numbers(metric_reader, row.name) == [8]
        sampling.cancel()
        await asyncio.gather(sampling, return_exceptions=True)

    run(scenario())


def test_a_sampled_number_is_read_at_once_and_then_once_in_each_export_interval(metric_reader: InMemoryMetricReader) -> None:
    async def scenario() -> None:
        reads: list[float] = []

        async def read() -> int | None:
            reads.append(asyncio.get_running_loop().time())
            return len(reads)

        name = "semiont.test.sampled.each_interval"
        sampling = await under_way(Exporting(Lag(), lambda: None, 60_000).sample(name, read, description="A test's own"))
        assert len(reads) == 1
        for read_so_far in (1, 2, 3):
            # Fifty seconds of the sixty have passed, and it has not been read again.
            await pass_time(50.0, step=10.0)
            assert len(reads) == read_so_far
            await pass_time(10.0, step=10.0)
            assert len(reads) == read_so_far + 1
        assert numbers(metric_reader, name) == [4]
        sampling.cancel()
        await asyncio.gather(sampling, return_exceptions=True)

    run(scenario())


def test_a_number_is_sampled_for_as_long_as_that_is_awaited_and_is_not_reported_afterwards(metric_reader: InMemoryMetricReader) -> None:
    async def scenario() -> None:
        reads: list[float] = []

        async def read() -> int | None:
            reads.append(asyncio.get_running_loop().time())
            return 7

        name = "semiont.test.sampled.until_cancelled"
        sampling = await under_way(Exporting(Lag(), lambda: None, 60_000).sample(name, read, description="A test's own"))
        assert numbers(metric_reader, name) == [7]
        sampling.cancel()
        await asyncio.gather(sampling, return_exceptions=True)
        assert sampling.cancelled()
        # Nothing reads it now, so the number last read says nothing of now: it is not reported, and it is not read again.
        assert numbers(metric_reader, name) == []
        await pass_time(180.0, step=60.0)
        assert len(reads) == 1
        assert numbers(metric_reader, name) == []

    run(scenario())


# ── a process that ends ─────────────────────────────────────────────────


def test_a_failure_nothing_caught_is_counted_once_under_the_reason_the_table_lists(metric_reader: InMemoryMetricReader) -> None:
    (row,) = metrics_named("semiont.process.abnormal_exit").values()
    assert row.instrument == "counter"
    (listed,) = row.attributes
    assert listed.key == "reason"
    before = counted(metric_reader, row.name, "reason")
    Exporting(Lag(), lambda: None, 30_000).died()
    added = counted(metric_reader, row.name, "reason") - before
    assert sum(added.values()) == 1
    ((reason,),) = added
    assert listed.values is not None
    assert reason in listed.values


def test_what_is_buffered_is_sent_when_the_process_stops_and_a_collector_that_does_not_answer_holds_it_two_seconds_at_most() -> None:
    ended = threading.Event()
    Exporting(Lag(), ended.set, 30_000).shutdown()
    assert ended.is_set()

    # A last export that never returns: the process waits two seconds for it, and goes.
    never = threading.Event()

    def unanswered() -> None:
        never.wait(30)

    began = time.monotonic()
    Exporting(Lag(), unanswered, 30_000).shutdown()
    waited = time.monotonic() - began
    never.set()
    assert 1.9 < waited < 5
