"""The two conformance drivers speak the suite's protocol (`tests/conformance/sdk/README.md`)."""

import subprocess
import sys

import pytest
from pydantic import JsonValue, TypeAdapter
from spec import PACKAGE

_LINES = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


@pytest.mark.parametrize("driver", ["wire", "live"])
def test_a_driver_says_it_is_ready_answers_each_operation_once_and_exits_when_its_stdin_ends(driver: str) -> None:
    asked = b'{"id": 1, "op": "open", "baseUrl": "http://127.0.0.1:1"}\n{"id": 2, "op": "no-such-operation"}\n'
    ran = subprocess.run([sys.executable, str(PACKAGE / "conformance" / f"{driver}.py")], input=asked, capture_output=True, check=False)
    assert ran.returncode == 0, ran.stderr.decode()
    said = [_LINES.validate_json(line) for line in ran.stdout.splitlines()]
    assert said == [{"ready": True}, {"id": 1, "unsupported": True}, {"id": 2, "unsupported": True}]
