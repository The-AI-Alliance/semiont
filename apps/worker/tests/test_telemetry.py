"""What the worker tells OpenTelemetry beside what its bounded calls and its descents tell.

It is held to `specs/src/service-telemetry/telemetry.json`. A call's span is held where the bound is (`test_inference_call.py`), and a
descent's calls where the descent is (`test_chunk_plan.py`).
"""

from collections import Counter

from opentelemetry.sdk.metrics.export import InMemoryMetricReader, NumberDataPoint, Sum
from telemetry_rows import worker_metrics

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
    assert anchors(metric_reader) - before == Counter({(("anchor.method", "fuzzy-match"), ("detection.label", "tag")): 1})
    assert sorted(attribute.key for attribute in row.attributes) == ["anchor.method", "detection.label"]
