"""The service's one logger, and how the process's log is written.

Every event is a short message with its facts beside it (`extra`), each under
a name in camel case. Once the service is configured, each event is one line
on stdout, in the form its configuration document names: as one JSON object,
or as `<when> [<LEVEL>] [weaver] <message>` followed by the facts as JSON.
Either carries the trace and the span the event was logged in, where it was
logged in one.

How much is written is the document's too. Its level is the least severe
event the service's own code writes: this package's, the graph stores' and
the SDK's. Of whatever else runs in the process, warnings and errors are
written, and nothing less. A Python warning is an event like any other, and
nothing is written to stderr.
"""

import json
import logging
import sys
import traceback
from datetime import UTC, datetime
from typing import Final, assert_never, final, override

from opentelemetry import trace
from semiont.types import LogFormat, LogLevel

LOG: Final = logging.getLogger("semiont_weaver")

_COMPONENT: Final = "weaver"
"""What says the event, among a knowledge base's services."""

_OF_EVERY_RECORD: Final = frozenset({*vars(logging.LogRecord("", 0, "", 0, "", None, None)), "message", "asctime"})
"""What every record carries. Whatever else one carries is the facts its event was logged with."""


def _threshold(level: LogLevel) -> int:
    """The least severe of Python's levels that `level` writes."""
    match level:
        case "error":
            return logging.ERROR
        case "warn":
            return logging.WARNING
        case "info" | "http":
            # `http` is the level between `info` and `debug`. Nothing here is logged at it, so it writes what `info` does.
            return logging.INFO
        case "debug":
            return logging.DEBUG
        case _:
            assert_never(level)


def _level(record: logging.LogRecord) -> LogLevel:
    """How grave an event is, in the protocol's words for it."""
    if record.levelno >= logging.ERROR:
        return "error"
    if record.levelno >= logging.WARNING:
        return "warn"
    if record.levelno >= logging.INFO:
        return "info"
    return "debug"


def _active_span() -> tuple[str, str] | None:
    """The trace and the span this code is running in, each as the hex text a trace's readers know it by. Nothing where it runs in none."""
    context = trace.get_current_span().get_span_context()
    if not context.is_valid:
        return None
    return trace.format_trace_id(context.trace_id), trace.format_span_id(context.span_id)


def _facts(record: logging.LogRecord) -> dict[str, object]:
    """What an event was logged with: its facts, the failure it was logged for, and the trace it was logged in."""
    facts: dict[str, object] = {name: value for name, value in vars(record).items() if name not in _OF_EVERY_RECORD}
    if record.exc_info is not None and record.exc_info[0] is not None:
        facts["stack"] = "".join(traceback.format_exception(*record.exc_info))
    span = _active_span()
    if span is not None:
        facts["trace_id"], facts["span_id"] = span
    return facts


def _when(record: logging.LogRecord) -> datetime:
    return datetime.fromtimestamp(record.created, UTC)


def _as_json(value: object) -> str:
    """`value` as JSON on one line. What JSON has no form for is written as its own text."""
    return json.dumps(value, ensure_ascii=False, default=str)


@final
class _Json(logging.Formatter):
    """An event as one JSON object: its level, its message, when, who said it, and its facts."""

    @override
    def format(self, record: logging.LogRecord) -> str:
        return _as_json(
            {
                "level": _level(record),
                "message": record.getMessage(),
                "timestamp": _when(record).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "component": _COMPONENT,
                **_facts(record),
            }
        )


@final
class _Simple(logging.Formatter):
    """An event as `<when> [<LEVEL>] [<component>] <message>`, and its facts after it as JSON. When is UTC.

    An event is one line: a line end inside a message is written as the two
    characters `\\n`.
    """

    @override
    def format(self, record: logging.LogRecord) -> str:
        facts = _facts(record)
        message = record.getMessage().replace("\r", "\\r").replace("\n", "\\n")
        said = f"{_when(record):%Y-%m-%d %H:%M:%S} [{_level(record).upper()}] [{_COMPONENT}] {message}"
        return f"{said} {_as_json(facts)}" if facts else said


def _formatter(log_format: LogFormat) -> logging.Formatter:
    match log_format:
        case "json":
            return _Json()
        case "simple":
            return _Simple()
        case _:
            assert_never(log_format)


def configure(level: LogLevel, log_format: LogFormat) -> None:
    """From here on the process's log is written to stdout, an event a line, as the configuration document says."""
    written = logging.StreamHandler(sys.stdout)
    written.setFormatter(_formatter(log_format))
    everything = logging.getLogger()
    everything.addHandler(written)
    least = _threshold(level)
    everything.setLevel(max(least, logging.WARNING))
    for own in (LOG, logging.getLogger("semiont_graph"), logging.getLogger("semiont")):
        own.setLevel(least)
    logging.captureWarnings(True)
