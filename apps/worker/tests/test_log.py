"""How the process's log is written: an event a line, on stdout, in the form and from the level its configuration document names.

`docs/protocol/WORKER-SERVICE.md` O1 states it, and the worker service's
conformance suite holds the lines a started service writes. Here is each
form's own shape, and what is and is not written.
"""

import json
import logging
import re
import warnings

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from pydantic import JsonValue, TypeAdapter
from semiont.types import LogFormat, LogLevel

from semiont_worker.log import LOG, configure

_LINE = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


def lines(capsys: pytest.CaptureFixture[str]) -> list[str]:
    """Every line written to stdout so far, with nothing written to stderr."""
    captured = capsys.readouterr()
    assert captured.err == ""
    return captured.out.splitlines()


def configured(level: LogLevel, log_format: LogFormat) -> None:
    configure(level, log_format)


@pytest.mark.usefixtures("unconfigured")
def test_as_json_an_event_is_one_object_with_its_level_its_message_when_who_said_it_and_its_facts(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configured("info", "json")
    LOG.info("Processing job", extra={"jobId": "job-1", "serves": [{"jobType": "yield"}], "attempt": 2})
    (line,) = lines(capsys)
    event = _LINE.validate_json(line)
    when = event.pop("timestamp")
    assert isinstance(when, str)
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", when)
    assert event == {
        "level": "info",
        "message": "Processing job",
        "component": "worker",
        "jobId": "job-1",
        "serves": [{"jobType": "yield"}],
        "attempt": 2,
    }


@pytest.mark.usefixtures("unconfigured")
def test_each_level_is_said_in_the_protocol_s_word_for_it(capsys: pytest.CaptureFixture[str]) -> None:
    configured("debug", "json")
    LOG.debug("a")
    LOG.info("b")
    LOG.warning("c")
    LOG.error("d")
    LOG.critical("e")
    assert [_LINE.validate_json(line)["level"] for line in lines(capsys)] == ["debug", "info", "warn", "error", "error"]


@pytest.mark.usefixtures("unconfigured")
def test_plainly_an_event_is_when_how_grave_who_and_the_message_with_its_facts_after_it_as_json(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configured("info", "simple")
    LOG.info("Health endpoint ready", extra={"port": 24100})
    LOG.warning("Claim declined; parked until the next wake-up")
    ready, declined = lines(capsys)
    stamped = re.fullmatch(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[INFO\] \[worker\] Health endpoint ready (\{.*\})", ready)
    assert stamped is not None
    assert json.loads(stamped.group(2)) == {"port": 24100}
    # An event with no facts has nothing after its message.
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[WARN\] \[worker\] Claim declined; parked until the next wake-up", declined)


@pytest.mark.usefixtures("unconfigured")
@pytest.mark.parametrize("log_format", ["json", "simple"])
def test_an_event_is_one_line_whatever_its_message_and_its_facts_hold(capsys: pytest.CaptureFixture[str], log_format: LogFormat) -> None:
    configured("info", log_format)
    LOG.error("first\nsecond\r\nthird", extra={"error": "one\ntwo", "what": {1, 2} - {2}})
    (line,) = lines(capsys)
    if log_format == "json":
        event = _LINE.validate_json(line)
        assert (event["message"], event["error"]) == ("first\nsecond\r\nthird", "one\ntwo")
        # What JSON has no form for is written as its own text.
        assert event["what"] == "{1}"
    else:
        assert "] first\\nsecond\\r\\nthird {" in line


@pytest.mark.usefixtures("unconfigured")
@pytest.mark.parametrize("log_format", ["json", "simple"])
def test_a_failure_an_event_is_logged_for_is_among_its_facts_and_on_its_line(
    capsys: pytest.CaptureFixture[str], log_format: LogFormat
) -> None:
    configured("info", log_format)
    try:
        raise ValueError("the model answered nothing")
    except ValueError as failure:
        LOG.error("Job failed", extra={"jobId": "job-1"}, exc_info=failure)
    (line,) = lines(capsys)
    facts = _LINE.validate_json(line if log_format == "json" else line[line.index("{") :])
    stack = facts["stack"]
    assert isinstance(stack, str)
    assert stack.startswith("Traceback (most recent call last):\n")
    assert stack.rstrip().endswith("ValueError: the model answered nothing")


@pytest.mark.usefixtures("unconfigured")
@pytest.mark.parametrize(
    ("level", "written"),
    [("error", ["error"]), ("warn", ["warn", "error"]), ("info", ["info", "warn", "error"]), ("http", ["info", "warn", "error"])],
)
def test_the_document_s_level_is_the_least_severe_event_written(
    capsys: pytest.CaptureFixture[str], level: LogLevel, written: list[str]
) -> None:
    configured(level, "json")
    LOG.debug("a")
    LOG.info("b")
    LOG.warning("c")
    LOG.error("d")
    assert [_LINE.validate_json(line)["level"] for line in lines(capsys)] == written


@pytest.mark.usefixtures("unconfigured")
def test_the_drivers_and_the_sdk_are_written_from_the_document_s_level_and_anything_else_from_warnings_up(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configured("debug", "json")
    for name in ("semiont_inference", "semiont.http", "httpx", "anthropic"):
        logging.getLogger(name).debug("quiet")
        logging.getLogger(name).info("said")
        logging.getLogger(name).warning("warned")
    said = [_LINE.validate_json(line)["message"] for line in lines(capsys)]
    assert said == ["quiet", "said", "warned", "quiet", "said", "warned", "warned", "warned"]


@pytest.mark.usefixtures("unconfigured")
def test_a_level_above_warnings_holds_back_the_warnings_of_everything(capsys: pytest.CaptureFixture[str]) -> None:
    configured("error", "json")
    for name in ("semiont_worker", "semiont.http", "httpx"):
        logging.getLogger(name).warning("warned")
        logging.getLogger(name).error("failed")
    assert [_LINE.validate_json(line)["message"] for line in lines(capsys)] == ["failed", "failed", "failed"]


@pytest.mark.usefixtures("unconfigured")
def test_a_python_warning_is_an_event_on_stdout_and_nothing_on_stderr(capsys: pytest.CaptureFixture[str]) -> None:
    configured("info", "simple")
    with warnings.catch_warnings():
        warnings.simplefilter("always")
        warnings.warn("this call is going away", DeprecationWarning, stacklevel=1)
    (line,) = lines(capsys)
    assert re.match(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[WARN\] \[worker\] ", line)
    assert "DeprecationWarning: this call is going away" in line


@pytest.mark.usefixtures("unconfigured")
@pytest.mark.parametrize("log_format", ["json", "simple"])
def test_an_event_logged_in_a_span_carries_its_trace_and_its_span(
    capsys: pytest.CaptureFixture[str], exported_spans: InMemorySpanExporter, log_format: LogFormat
) -> None:
    assert exported_spans is not None
    configured("info", log_format)
    LOG.info("outside")
    with trace.get_tracer("test").start_as_current_span("held") as span:
        LOG.info("inside")
        context = span.get_span_context()
    outside, inside = lines(capsys)
    read = [
        _LINE.validate_json(line if log_format == "json" else (line[line.index("{") :] if "{" in line else "{}"))
        for line in (outside, inside)
    ]
    assert "trace_id" not in read[0]
    assert "span_id" not in read[0]
    assert (read[1]["trace_id"], read[1]["span_id"]) == (f"{context.trace_id:032x}", f"{context.span_id:016x}")
