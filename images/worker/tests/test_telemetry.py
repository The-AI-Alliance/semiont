"""What the worker tells OpenTelemetry beside what its bounded calls and its descents tell.

It is held to `specs/src/service-telemetry/telemetry.json`. A call's span is held where the bound is (`test_inference_call.py`), and a
descent's calls where the descent is (`test_chunk_plan.py`).
"""

import asyncio
from collections import Counter
from contextvars import Context

import pytest
from aio import run, turns
from holding import EVERY_JOB, KB, Parties, answering, job
from opentelemetry.sdk.metrics.export import Histogram, HistogramDataPoint, InMemoryMetricReader, NumberDataPoint, Sum
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from semiont.identity import kb_did
from standing_in import GENERATOR
from telemetry_rows import TABLE, MetricRow, SpanRow, worker_metrics

from semiont_worker.agent import run_what_is_claimed
from semiont_worker.telemetry import record_anchor

ANCHORS = "semiont.detection.anchors"


def anchors(reader: InMemoryMetricReader) -> Counter[tuple[tuple[str, object], ...]]:
    """How many anchors have been counted so far, by everything each is filed under."""
    so_far: Counter[tuple[tuple[str, object], ...]] = Counter()
    data = reader.get_metrics_data()
    if data is None:
        return so_far
    for found in (metric for resource in data.resource_metrics for scope in resource.scope_metrics for metric in scope.metrics):
        if found.name == ANCHORS:
            assert isinstance(found.data, Sum)
            assert found.data.is_monotonic
            for point in found.data.data_points:
                assert isinstance(point, NumberDataPoint)
                so_far[tuple(sorted((point.attributes or {}).items()))] += int(point.value)
    return so_far


def test_an_anchor_is_counted_once_by_what_was_anchored_and_how_under_the_keys_the_table_lists(metric_reader: InMemoryMetricReader) -> None:
    (row,) = worker_metrics(ANCHORS).values()
    assert row.instrument == "counter"
    before = anchors(metric_reader)
    record_anchor("tag", "fuzzy-match")
    assert anchors(metric_reader) - before == Counter(
        {(("anchor.method", "fuzzy-match"), ("detection.label", "tag"), ("semiont.kb", KB)): 1}
    )
    assert sorted(attribute.key for attribute in row.attributes) == ["anchor.method", "detection.label", "semiont.kb"]


def test_every_row_the_worker_alone_exports_names_the_knowledge_base_on_every_signal() -> None:
    # The rows it shares are others' too: what the process says of itself, and what a driver records of a generation.
    rows: list[SpanRow | MetricRow] = [*TABLE.spans, *TABLE.metrics]
    own = [row for row in rows if row.services == ["worker"]]
    assert own
    for row in own:
        (kb,) = [attribute for attribute in row.attributes if attribute.key == "semiont.kb"]
        assert (kb.values, kb.only) == (None, None), row.name


def test_nothing_of_the_worker_s_own_is_recorded_outside_a_knowledge_base_s_claims() -> None:
    # A fresh context is one no knowledge base's claims are run in.
    with pytest.raises(LookupError):
        Context().run(record_anchor, "tag", "fuzzy-match")


def points_of(reader: InMemoryMetricReader, name: str) -> list[NumberDataPoint | HistogramDataPoint]:
    """Every point of the metric `name` recorded so far."""
    data = reader.get_metrics_data()
    if data is None:
        return []
    found = [
        metric for resource in data.resource_metrics for scope in resource.scope_metrics for metric in scope.metrics if metric.name == name
    ]
    points: list[NumberDataPoint | HistogramDataPoint] = []
    for metric in found:
        assert isinstance(metric.data, Sum | Histogram)
        points.extend(metric.data.data_points)
    return points


def test_a_job_s_spans_and_its_count_name_the_knowledge_base_whose_claims_handed_it_over(
    exported_spans: InMemorySpanExporter, metric_reader: InMemoryMetricReader
) -> None:
    # Another knowledge base than the one the tests run as: what the job records names the one it was claimed at.
    domain = "elsewhere.test"
    there = kb_did(domain)

    async def scenario() -> None:
        parties = Parties()
        # A text with nothing to read: the job is declined, and completes, without the model being asked.
        parties.text_resource(" \n")
        parties.queue.append(job("job-there", "mark", {"motivation": "highlighting"}))
        async with parties.client as client, client.job.claim(EVERY_JOB) as claims:
            working = asyncio.ensure_future(
                run_what_is_claimed(client, claims, inference=answering("[]"), generator=GENERATOR, accepts=EVERY_JOB, domain=domain)
            )
            for _ in range(20):
                await turns()
            assert [completion["jobId"] for completion in parties.sent("job:complete")] == ["job-there"]
            await claims.aclose()
            await asyncio.wait_for(working, 5)
        await parties.transport.close()

    exported_spans.clear()
    run(scenario())
    held = [span for span in exported_spans.get_finished_spans() if span.name in ("job:mark", "detection:prepare")]
    assert sorted(span.name for span in held) == ["detection:prepare", "job:mark"]
    assert [(span.attributes or {})["semiont.kb"] for span in held] == [there, there]

    for name in ("semiont.job.outcome", "semiont.job.duration"):
        points = [point for point in points_of(metric_reader, name) if (point.attributes or {})["semiont.kb"] == there]
        assert [dict(point.attributes or {}) for point in points] == [
            {"semiont.kb": there, "job.type": "mark", "job.motivation": "highlighting", "job.outcome": "completed"}
        ], name
