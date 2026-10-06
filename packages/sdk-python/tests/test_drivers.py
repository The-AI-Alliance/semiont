"""The two conformance drivers speak the suite's protocol (`tests/conformance/sdk/README.md`)."""

import subprocess
import sys
from typing import get_args

from pydantic import JsonValue, TypeAdapter
from spec import PACKAGE, JsonObject

from semiont.transport import ConnectionState

_LINES = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


def driven(driver: str, asked: list[JsonObject]) -> list[JsonObject]:
    """What a driver says when it is asked for `asked` and its stdin then ends. It is to exit 0."""
    lines = b"".join(_LINES.dump_json(line) + b"\n" for line in asked)
    ran = subprocess.run(
        [sys.executable, str(PACKAGE / "conformance" / f"{driver}.py")], input=lines, capture_output=True, check=False, timeout=60
    )
    assert ran.returncode == 0, ran.stderr.decode()
    return [_LINES.validate_json(line) for line in ran.stdout.splitlines()]


def test_the_live_driver_says_it_is_ready_and_performs_nothing() -> None:
    said = driven("live", [{"id": 1, "op": "open", "baseUrl": "http://127.0.0.1:1"}, {"id": 2, "op": "abandon", "request": 1}])
    assert said == [{"ready": True}, {"id": 1, "unsupported": True}, {"id": 2, "unsupported": True}]


def test_the_wire_driver_answers_each_operation_once_and_disposes_of_its_transport_when_its_stdin_ends() -> None:
    said = driven(
        "wire",
        [
            {"id": 1, "op": "no-such-operation"},
            {"id": 2, "op": "sync"},
            {"id": 3, "op": "listen", "channel": "beckon:focus"},
            {"id": 4, "op": "open", "baseUrl": "http://127.0.0.1:1", "token": "t", "channels": ["beckon:focus"], "timing": {"bogusMs": 1}},
            {
                "id": 5,
                "op": "open",
                "baseUrl": "http://127.0.0.1:1",
                "token": "t",
                "channels": ["beckon:focus"],
                "timing": {"reconnectMs": 5},
            },
            {"id": 6, "op": "open", "baseUrl": "http://127.0.0.1:1", "token": "t", "channels": ["beckon:focus"]},
            {"id": 7, "op": "listen", "channel": "mark:delete"},
            {"id": 8, "op": "subscribe-resource", "resource": "not an id"},
            {"id": 9, "op": "request", "operation": "browse:resource-requested", "payload": {}, "timeoutMs": 60000},
            {"id": 10, "op": "abandon", "request": 12},
            {"id": 11, "op": "put"},
            {"id": 12, "op": "sync"},
        ],
    )
    assert said[0] == {"ready": True}
    answers = {line["id"]: {name: value for name, value in line.items() if name != "id"} for line in said if "id" in line}
    assert sorted(answers, key=str) == sorted(range(1, 13), key=str)
    assert answers[1] == {"unsupported": True}
    assert answers[2] == {"ok": None}
    assert answers[3] == {"misuse": "no transport is open"}
    assert answers[4] == {"misuse": "this driver cannot override bogusMs"}
    assert answers[5] == {"ok": None}
    assert answers[6] == {"misuse": "a transport is already open"}
    # A channel the stream does not carry is refused by the SDK, under its code.
    failed = answers[7]["error"]
    assert isinstance(failed, dict)
    assert failed["code"] == "bus.unsubscribed"
    assert "misuse" in answers[8]
    # The reply channels are not among the stream's: refused at once, with nothing sent.
    unsubscribed = answers[9]["error"]
    assert isinstance(unsubscribed, dict)
    assert unsubscribed["code"] == "bus.unsubscribed"
    assert answers[10] == {"misuse": "no such request is unsettled"}
    assert answers[11] == {"misuse": "name must be a string"}
    assert answers[12] == {"ok": None}
    # Nothing answers at that address: the stream is a state, never a failure, and every state is one of the contract's.
    states = [line["state"] for line in said if "state" in line]
    assert states[0] == "initial"
    assert states[-1] == "closed"
    assert set(states) <= set(get_args(ConnectionState.__value__))
    assert [line for line in said if "error" in line and "id" not in line] == []
