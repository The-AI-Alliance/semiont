"""What an event the service logs says of the trace it was logged in.

`docs/protocol/WEAVER.md` § Telemetry: an event logged while a span is
current carries that span's trace and its own id, in either form of the log,
so that a line can be found from a trace and a trace from a line. One logged
in no span carries neither.
"""

import pytest
from opentelemetry.sdk.trace import TracerProvider
from pydantic import JsonValue, TypeAdapter
from semiont.types import LogFormat

from semiont_weaver.log import LOG, configure

pytestmark = pytest.mark.usefixtures("the_log_as_it_was")

_LINE = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


def facts(line: str, log_format: LogFormat) -> dict[str, JsonValue]:
    """The facts a line carries: the whole object as JSON, and what follows the message otherwise."""
    if log_format == "json":
        return _LINE.validate_json(line)
    return _LINE.validate_json(line[line.index("{") :]) if "{" in line else {}


@pytest.mark.parametrize("log_format", ["json", "simple"])
def test_an_event_logged_in_a_span_carries_its_trace_and_its_span(capsys: pytest.CaptureFixture[str], log_format: LogFormat) -> None:
    configure("info", log_format)
    LOG.info("outside")
    with TracerProvider().get_tracer("test").start_as_current_span("held") as span:
        LOG.info("inside")
        context = span.get_span_context()

    outside, inside = (facts(line, log_format) for line in capsys.readouterr().out.splitlines())
    assert "trace_id" not in outside
    assert "span_id" not in outside
    assert (inside["trace_id"], inside["span_id"]) == (f"{context.trace_id:032x}", f"{context.span_id:016x}")
