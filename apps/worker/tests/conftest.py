"""What the tests of this project share: the one tracer provider and the one meter provider a process may install, each read in memory.

A process installs each once, and a second installing is refused. So a test
that reads what the service told OpenTelemetry asks for one of these, and
installs nothing itself. What is read is everything the run has recorded so
far: a test says which of it is its own.
"""

import pytest
from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


@pytest.fixture(scope="session")
def exported_spans() -> InMemorySpanExporter:
    """Every span ended since this was first asked for, in the order they ended."""
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    return exporter


@pytest.fixture(scope="session")
def metric_reader() -> InMemoryMetricReader:
    """What reads every metric recorded since this was first asked for, each as its sum so far."""
    reader = InMemoryMetricReader()
    metrics.set_meter_provider(MeterProvider(metric_readers=[reader]))
    return reader
