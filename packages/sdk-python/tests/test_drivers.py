"""The conformance drivers speak their suites' protocol (`tests/conformance/sdk/README.md`, `tests/conformance/worker/README.md`)."""

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
        [sys.executable, str(PACKAGE / "conformance" / f"{driver}.py")], input=lines, capture_output=True, check=False, timeout=20
    )
    assert ran.returncode == 0, ran.stderr.decode()
    return [_LINES.validate_json(line) for line in ran.stdout.splitlines()]


def test_the_live_driver_answers_each_operation_once_and_disposes_of_its_client_when_its_stdin_ends() -> None:
    resource: JsonObject = {"query": "resource", "resource": "res-1"}
    opening: JsonObject = {"op": "open", "baseUrl": "http://127.0.0.1:1", "token": "t"}
    tagging: JsonObject = {"motivation": "tagging", "schemaId": "s1", "categories": ["claim"]}
    said = driven(
        "live",
        [
            {"id": 1, "op": "no-such-operation"},
            {"id": 2, "op": "observe", "observer": "a", "query": resource},
            {"id": 3, **opening, "timing": {"bogusMs": 1}},
            {"id": 4, **opening, "timing": {"busRequestTimeoutMs": 60000, "reconnectMs": 5}, "persist": True},
            {"id": 5, **opening},
            {"id": 6, "op": "observe", "observer": "a", "query": {"query": "no-such-query"}},
            {"id": 7, "op": "observe", "observer": "a", "query": {"query": "resource", "resource": "not an id"}},
            {"id": 8, "op": "observe", "observer": "a", "query": {"query": "resources", "filters": {"colour": "red"}}},
            {"id": 9, "op": "observe", "observer": "a", "query": resource},
            {"id": 10, "op": "observe", "observer": "a", "query": resource},
            {"id": 11, "op": "unobserve", "observer": "b"},
            {"id": 12, "op": "observe", "observer": "b", "query": {"query": "agents"}},
            {"id": 13, "op": "invalidate", "query": resource},
            {"id": 14, "op": "markDelegate", "observer": "c", "resource": "res-1", "params": {"motivation": "applauding"}},
            {"id": 15, "op": "yieldDelegate", "observer": "c", "params": {}, "stallDeadlineMs": 5},
            {"id": 16, "op": "unobserve", "observer": "b"},
            {"id": 17, "op": "sync"},
            {"id": 18, "op": "close"},
            {"id": 19, "op": "fresh", "query": resource},
            {"id": 20, "op": "observe", "observer": "d", "query": resource},
            {"id": 21, **opening},
            {"id": 22, "op": "observe", "observer": "a", "query": resource},
            {"id": 23, "op": "markDelegate", "observer": "e", "resource": "res-1", "params": tagging},
            {"id": 24, "op": "markDelegate", "observer": "f", "resource": "res-1", "params": {**tagging, "tone": "scholarly"}},
            {"id": 25, "op": "yieldDelegate", "observer": "f", "params": tagging, "stallDeadlineMs": 5},
        ],
    )
    assert said[0] == {"ready": True}
    answers = {line["id"]: {name: value for name, value in line.items() if name != "id"} for line in said if "id" in line}
    assert sorted(answers, key=str) == sorted(range(1, 26), key=str)
    assert answers[1] == {"unsupported": True}
    assert answers[2] == {"misuse": "no client is open"}
    assert answers[3] == {"misuse": "this driver cannot override bogusMs"}
    assert answers[4] == {"ok": None}
    assert answers[5] == {"misuse": "a client is already open"}
    assert answers[6] == {"misuse": "no live query no-such-query"}
    assert "misuse" in answers[7]
    assert answers[8] == {"misuse": "a filter by colour, which no query of resources takes"}
    assert answers[9] == {"ok": None}
    assert answers[10] == {"misuse": "a is already observing"}
    assert answers[11] == {"misuse": "b is not observing"}
    assert answers[12] == {"ok": None}
    assert answers[13] == {"ok": None}
    assert "misuse" in answers[14]
    assert "misuse" in answers[15]
    assert answers[16] == {"ok": None}
    assert answers[17] == {"ok": None}
    assert answers[18] == {"ok": None}
    # A closed client stays the driver's: a read of it is refused by the SDK, under its code.
    refused = answers[19]["error"]
    assert isinstance(refused, dict)
    assert refused["code"] == "bus.closed"
    assert answers[20] == {"ok": None}
    # And the next `open` replaces it: its observers' names are free again.
    assert answers[21] == {"ok": None}
    assert answers[22] == {"ok": None}
    # A job is delegated with the parameters its motivation takes, and with no others: a `mark` job's are not a `yield` job's.
    assert answers[23] == {"ok": None}
    assert "misuse" in answers[24]
    assert "misuse" in answers[25]

    emissions = [line["emission"] for line in said if "emission" in line]
    # Nothing answers at that address, so a query waits: pending is a state, and the only one there was.
    assert {"observer": "a", "state": {"status": "pending"}} in emissions
    assert {"observer": "b", "state": {"status": "pending"}} in emissions
    queries = [emission for emission in emissions if isinstance(emission, dict) and emission["observer"] != "e"]
    assert all(emission["state"] == {"status": "pending"} for emission in queries)
    # And a job's creation is never answered: its follower is told the client closed, and ends.
    [followed] = [emission["state"] for emission in emissions if isinstance(emission, dict) and emission["observer"] == "e"]
    assert isinstance(followed, dict)
    assert followed["status"] == "failed"
    refusal = followed["error"]
    assert isinstance(refusal, dict)
    assert refusal["code"] == "bus.closed"
    completed = [line["completed"] for line in said if "completed" in line]
    assert "e" in completed
    assert "f" not in completed
    # Closing the client ended its observers; one that was let go was told nothing; one that arrived after had nothing to see.
    assert completed.count("a") == 2
    assert "b" not in completed
    assert "d" in completed
    assert said.index({"completed": "d"}) > said.index({"id": 18, "ok": None})
    states = [line["state"] for line in said if "state" in line]
    assert states[0] == "initial"
    assert states[-1] == "closed"
    assert set(states) <= set(get_args(ConnectionState.__value__))


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


def test_the_worker_driver_answers_each_operation_once_and_fails_nothing_when_its_stdin_ends() -> None:
    opening: JsonObject = {"op": "open", "baseUrl": "http://127.0.0.1:1", "token": "t"}
    highlighting: JsonObject = {"jobType": "mark", "params": {"motivation": "highlighting"}}
    waits: JsonObject = {"reconnectMs": 5, "jobClaimTimeoutMs": 50, "heldJobStallMs": 100, "heldJobStallCheckMs": 10}
    said = driven(
        "worker",
        [
            {"id": 1, "op": "no-such-operation"},
            {"id": 2, "op": "claim", "accepts": [highlighting]},
            {"id": 3, **opening, "timing": {"bogusMs": 1}},
            {"id": 4, **opening, "timing": waits},
            {"id": 5, **opening},
            {"id": 6, "op": "vitals"},
            {"id": 7, "op": "start"},
            {"id": 8, "op": "subscribe-resource", "resource": "not an id"},
            {"id": 9, "op": "claim", "accepts": [{"jobType": "applaud"}]},
            {"id": 10, "op": "claim", "accepts": [highlighting, {"jobType": "yield"}]},
            {"id": 11, "op": "claim", "accepts": []},
            {"id": 12, "op": "vitals"},
            {"id": 13, "op": "complete", "result": {}},
            {"id": 14, "op": "sync"},
        ],
    )
    assert said[0] == {"ready": True}
    answers = {line["id"]: {name: value for name, value in line.items() if name != "id"} for line in said if "id" in line}
    assert sorted(answers, key=str) == sorted(range(1, 15), key=str)
    assert answers[1] == {"unsupported": True}
    assert answers[2] == {"misuse": "no transport is open"}
    assert answers[3] == {"misuse": "this driver cannot override bogusMs"}
    assert answers[4] == {"ok": None}
    assert answers[5] == {"misuse": "a transport is already open"}
    assert answers[6] == {"misuse": "the worker is not claiming"}
    assert answers[7] == {"misuse": "the worker has held no job"}
    assert "misuse" in answers[8]
    # A filter is the SDK's type for one: what it refuses is the suite's mistake, never a claim.
    assert "misuse" in answers[9]
    assert answers[10] == {"ok": None}
    assert answers[11] == {"misuse": "the worker is already claiming"}
    # Nothing answers at that address, so the worker holds nothing and has finished nothing.
    vitals = answers[12]["ok"]
    assert isinstance(vitals, dict)
    assert vitals["activeJob"] is None
    assert vitals["jobsCompleted"] == 0
    assert vitals["lastFinishedAt"] is None
    assert answers[13] == {"misuse": "the worker has held no job"}
    assert answers[14] == {"ok": None}
    # It claimed nothing and was refused nothing it could say of: a claim nobody answers is not a refusal the worker made up.
    assert [line for line in said if "claimed" in line or "signalled" in line or "stalled" in line] == []
    states = [line["state"] for line in said if "state" in line]
    assert states[0] == "initial"
    assert states[-1] == "closed"
    assert set(states) <= set(get_args(ConnectionState.__value__))
