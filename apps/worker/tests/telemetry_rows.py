"""The rows of `specs/src/service-telemetry/telemetry.json` that list the worker, for the tests that hold what the service records."""

from typing import Final

from pydantic import BaseModel
from spec import SPEC


class Attribute(BaseModel, frozen=True, extra="forbid"):
    key: str
    values: list[str] | None = None
    """The only values it takes, where the row lists them."""
    only: str | None = None
    """When it is carried, where that is not always."""


class SpanRow(BaseModel, frozen=True):
    name: str
    services: list[str]
    kind: str
    attributes: list[Attribute]


class MetricRow(BaseModel, frozen=True):
    name: str
    services: list[str]
    instrument: str
    attributes: list[Attribute]


class Table(BaseModel, frozen=True):
    spans: list[SpanRow]
    metrics: list[MetricRow]


TABLE: Final = Table.model_validate_json((SPEC / "service-telemetry/telemetry.json").read_bytes())


def worker_spans(prefix: str) -> dict[str, SpanRow]:
    """The spans the worker exports whose names begin `prefix`, by name."""
    return {row.name: row for row in TABLE.spans if "worker" in row.services and row.name.startswith(prefix)}


def worker_metrics(prefix: str) -> dict[str, MetricRow]:
    """The metrics the worker exports whose names begin `prefix`, by name."""
    return {row.name: row for row in TABLE.metrics if "worker" in row.services and row.name.startswith(prefix)}


def as_the_table_writes(value: object) -> str:
    """An attribute's value as the table lists one: text, with a truth value as OTLP writes it."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)
