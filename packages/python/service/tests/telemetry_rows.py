"""The metric rows of `specs/src/service-telemetry/telemetry.json`, for the tests that hold what a process reports of itself."""

from typing import Final

from pydantic import BaseModel
from spec import SPEC


class Attribute(BaseModel, frozen=True, extra="forbid"):
    key: str
    values: list[str] | None = None
    """The only values it takes, where the row lists them."""
    only: str | None = None
    """When it is carried, where that is not always."""


class MetricRow(BaseModel, frozen=True):
    name: str
    services: list[str]
    instrument: str
    attributes: list[Attribute]


class Table(BaseModel, frozen=True):
    metrics: list[MetricRow]


TABLE: Final = Table.model_validate_json((SPEC / "service-telemetry/telemetry.json").read_bytes())


def metrics_named(prefix: str) -> dict[str, MetricRow]:
    """The metrics of the table whose names begin `prefix`, by name."""
    return {row.name: row for row in TABLE.metrics if row.name.startswith(prefix)}


def as_the_table_writes(value: object) -> str:
    """An attribute's value as the table lists one: text, with a truth value as OTLP writes it."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)
