"""What the service has counted so far, read from the meter provider the tests install (`conftest.py`)."""

from collections import Counter
from collections.abc import Sequence

from opentelemetry.sdk.metrics.export import InMemoryMetricReader, NumberDataPoint, ResourceMetrics, Sum


def counted(reader: InMemoryMetricReader, name: str, *keys: str) -> Counter[tuple[object, ...]]:
    """What the counter `name` stands at, by the values its points carry under `keys`. One nothing has been added to stands at nothing.

    A point that carries any other attribute than `keys`, or lacks one of
    them, fails.
    """
    data = reader.get_metrics_data()
    resources: Sequence[ResourceMetrics] = [] if data is None else data.resource_metrics
    so_far: Counter[tuple[object, ...]] = Counter()
    for resource in resources:
        for scope in resource.scope_metrics:
            for metric in scope.metrics:
                if metric.name != name:
                    continue
                assert isinstance(metric.data, Sum), f"{name} is no sum"
                assert metric.data.is_monotonic, f"{name} is no counter"
                for point in metric.data.data_points:
                    assert isinstance(point, NumberDataPoint)
                    attributes = point.attributes or {}
                    assert sorted(attributes) == sorted(keys), f"a point of {name} carries {sorted(attributes)}"
                    so_far[tuple(attributes[key] for key in keys)] += int(point.value)
    return so_far
