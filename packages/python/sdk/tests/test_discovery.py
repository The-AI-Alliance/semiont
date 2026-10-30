"""The knowledge bases a launcher manages: what its document says, what changed between two readings of it, and reading it over HTTP."""

import asyncio
from collections.abc import Sequence
from typing import Final, final, override

import pytest
from aio import hurried, pass_time, run, run_still
from gateway_server import Answer, GatewayServer
from pydantic import JsonValue, TypeAdapter
from spec import JsonObject

from semiont.discovery import (
    DISCOVERY_INTERVAL,
    Absent,
    DiscoveryAbsentReason,
    DiscoveryDiff,
    DiscoveryRead,
    DiscoveryState,
    DiscoveryTransport,
    Managed,
    Unchanged,
    parse_discovery_document,
    subscribe_discovery,
    text_discovery,
)
from semiont.http.discovery import http_discovery
from semiont.timing import HTTP_REQUEST_TIMEOUT_MS
from semiont.types import DiscoveredKB

_JSON: Final = TypeAdapter[JsonValue](JsonValue)

A: Final = "did:web:example.org:kb-a"
B: Final = "did:web:example.org:kb-b"
PATH: Final = "/discovery/kbs.json"


def entry(host: str, port: int, did: str) -> JsonObject:
    return {"host": host, "port": port, "placement": "local", "managedBy": "semiont-launcher", "did": did}


def written(value: JsonValue) -> str:
    return _JSON.dump_json(value).decode()


def document(*kbs: JsonValue) -> str:
    return written({"version": 1, "kbs": list(kbs)})


def kb(value: JsonObject) -> DiscoveredKB:
    return DiscoveredKB.model_validate(value)


CODESPACE: Final[JsonObject] = {
    "host": "localhost",
    "port": 4100,
    "placement": "codespace",
    "managedBy": "semiont-launcher",
    "did": B,
    "repo": "owner/name",
    "siteName": "A site",
}


# ── What the document says ──────────────────────────────────────────────


def test_a_document_of_knowledge_bases_is_managed_and_one_of_none_is_managed_too() -> None:
    assert parse_discovery_document(document(entry("localhost", 4000, A), CODESPACE)) == Managed(
        kbs=(kb(entry("localhost", 4000, A)), kb(CODESPACE))
    )
    # A launcher that manages nothing is there. It is not absent.
    assert parse_discovery_document(document()) == Managed(kbs=())


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("<!doctype html><html></html>", "not-json"),
        ("[]", "invalid"),
        (written({"kbs": []}), "invalid"),
        (written({"version": "1", "kbs": []}), "invalid"),
        (written({"version": True, "kbs": []}), "invalid"),
        (written({"version": 2, "kbs": []}), "unsupported-version"),
        (written({"version": 1}), "invalid"),
        (written({"version": 1, "kbs": ["localhost"]}), "invalid"),
        (document({"host": "localhost", "port": 4000, "placement": "elsewhere", "managedBy": "x", "did": A}), "invalid"),
        (document({"host": "localhost", "port": "4000", "placement": "local", "managedBy": "x", "did": A}), "invalid"),
        (document(entry("localhost", 0, A)), "invalid"),
        (document({"host": "localhost", "port": 70000, "placement": "local", "managedBy": "x", "did": A}), "invalid"),
    ],
)
def test_what_is_not_a_document_is_absent_and_says_why(text: str, expected: DiscoveryAbsentReason) -> None:
    state = parse_discovery_document(text)
    assert isinstance(state, Absent), f"read {state}"
    assert state.reason == expected
    assert state.diagnostic


def test_a_document_of_another_version_is_not_read_in_part() -> None:
    state = parse_discovery_document(written({"version": 2, "kbs": [entry("localhost", 4000, A)]}))
    assert isinstance(state, Absent)
    assert state.reason == "unsupported-version"
    assert state.diagnostic is not None
    assert "version 2" in state.diagnostic


def test_one_entry_that_is_not_one_makes_the_whole_document_absent() -> None:
    # A reading of the good entry alone would hide a running knowledge base.
    without_a_did: JsonObject = {"host": "localhost", "port": 4100, "placement": "local", "managedBy": "x"}
    state = parse_discovery_document(document(entry("localhost", 4000, A), without_a_did))
    assert isinstance(state, Absent)
    assert state.reason == "invalid"
    assert state.diagnostic is not None
    assert "did" in state.diagnostic


# ── Reading it as text ──────────────────────────────────────────────────


def read_of(text: str | None = None, failure: OSError | None = None) -> DiscoveryRead:
    async def reading() -> str:
        if failure is not None:
            raise failure
        assert text is not None
        return text

    return run(text_discovery(reading).read())


def test_text_is_read_through_the_one_validator() -> None:
    assert read_of(document(entry("localhost", 4000, A))) == Managed(kbs=(kb(entry("localhost", 4000, A)),))
    assert read_of(failure=FileNotFoundError("no such file")) == Absent(reason="not-found")
    assert read_of(failure=PermissionError("permission denied")) == Absent(reason="unreadable", diagnostic="permission denied")


# ── What changed ────────────────────────────────────────────────────────


@final
class Script(DiscoveryTransport):
    """A transport that gives what it was scripted to, in order, and then says nothing has changed."""

    def __init__(self, *reads: DiscoveryRead) -> None:
        self._reads = list(reads)
        self.asked = 0

    @override
    async def read(self) -> DiscoveryRead:
        self.asked += 1
        return self._reads.pop(0) if self._reads else Unchanged()


async def changes(script: Script, polls: int) -> list[DiscoveryDiff]:
    """Every change told of in `polls` readings."""
    told: list[DiscoveryDiff] = []

    async def listen() -> None:
        async for diff in subscribe_discovery(script, DISCOVERY_INTERVAL):
            told.append(diff)

    listening = asyncio.create_task(listen())
    await pass_time(DISCOVERY_INTERVAL * polls - 0.001)
    listening.cancel()
    await asyncio.gather(listening, return_exceptions=True)
    return told


def addresses(kbs: Sequence[DiscoveredKB]) -> list[str]:
    return [f"{found.host}:{found.port}" for found in kbs]


type Summary = tuple[list[str], list[str], list[str]]
"""A diff as what it added, changed and removed, by address."""


def summary(diff: DiscoveryDiff) -> Summary:
    return addresses(diff.added), addresses(diff.updated), addresses(diff.removed)


def reason(state: DiscoveryState) -> DiscoveryAbsentReason | None:
    return state.reason if isinstance(state, Absent) else None


def test_the_first_reading_is_told_whole_and_each_one_after_by_what_changed() -> None:
    renamed: JsonObject = {**entry("localhost", 4000, A), "siteName": "Renamed"}
    script = Script(
        parse_discovery_document(document(entry("localhost", 4000, A))),
        parse_discovery_document(document(renamed, entry("localhost", 4100, B))),
        parse_discovery_document(document(entry("localhost", 4100, B))),
    )
    told = run_still(changes(script, 4))

    assert [summary(diff) for diff in told] == [
        (["localhost:4000"], [], []),
        (["localhost:4100"], ["localhost:4000"], []),
        ([], [], ["localhost:4000"]),
    ]
    assert told[1].updated[0].site_name == "Renamed"
    assert script.asked == 4


def test_a_knowledge_base_that_moves_port_is_removed_and_added() -> None:
    script = Script(
        parse_discovery_document(document(entry("localhost", 4000, A))),
        parse_discovery_document(document(entry("localhost", 4001, A))),
    )
    told = run_still(changes(script, 2))

    assert len(told) == 2
    assert summary(told[1]) == (["localhost:4001"], [], ["localhost:4000"])


def test_a_reading_that_changed_nothing_is_not_told() -> None:
    same = parse_discovery_document(document(entry("localhost", 4000, A)))
    script = Script(same, Unchanged(), same, parse_discovery_document(document(entry("localhost", 4000, A))))
    told = run_still(changes(script, 5))

    assert len(told) == 1
    assert script.asked == 5


def test_an_entry_with_optional_members_read_again_unchanged_is_not_told() -> None:
    script = Script(parse_discovery_document(document(CODESPACE)), parse_discovery_document(document(CODESPACE)))
    assert len(run_still(changes(script, 2))) == 1


def test_a_launcher_that_goes_and_comes_back_is_told_with_what_it_took_and_brought() -> None:
    script = Script(
        parse_discovery_document("not json"),
        parse_discovery_document(document(entry("localhost", 4000, A))),
        parse_discovery_document("not json"),
        # Absent for another reason is a change too; for the same one it is not.
        parse_discovery_document("[]"),
        parse_discovery_document("{}"),
    )
    told = run_still(changes(script, 6))

    assert [(reason(diff.state), summary(diff)) for diff in told] == [
        ("not-json", ([], [], [])),
        (None, (["localhost:4000"], [], [])),
        ("not-json", ([], [], ["localhost:4000"])),
        ("invalid", ([], [], [])),
    ]


def test_one_knowledge_base_in_two_places_is_two_entries_and_each_is_its_own() -> None:
    both = parse_discovery_document(document(entry("localhost", 4000, A), entry("localhost", 4100, A)))
    script = Script(both, both, parse_discovery_document(document(entry("localhost", 4100, A))))
    told = run_still(changes(script, 4))

    # No change while both are there, and the one that stops is not hidden by the one that goes on.
    assert [summary(diff) for diff in told] == [
        (["localhost:4000", "localhost:4100"], [], []),
        ([], [], ["localhost:4000"]),
    ]
    assert [diff.duplicated for diff in told] == [(), ()]


def test_two_entries_at_one_address_are_named_and_neither_is_dropped_from_the_state() -> None:
    script = Script(
        parse_discovery_document(document(entry("localhost", 4000, A), entry("localhost", 4000, B), entry("localhost", 4100, B)))
    )
    told = run_still(changes(script, 1))

    assert len(told) == 1
    assert told[0].duplicated == ("localhost:4000",)
    state = told[0].state
    assert isinstance(state, Managed)
    assert len(state.kbs) == 3


def test_reading_stops_when_nobody_listens() -> None:
    async def scenario() -> tuple[int, int]:
        script = Script(parse_discovery_document(document()))

        async def listen() -> None:
            async for _ in subscribe_discovery(script, DISCOVERY_INTERVAL):
                pass

        listening = asyncio.create_task(listen())
        await pass_time(DISCOVERY_INTERVAL * 2)
        asked = script.asked
        listening.cancel()
        await asyncio.gather(listening, return_exceptions=True)
        await pass_time(DISCOVERY_INTERVAL * 5)
        return asked, script.asked

    asked, later = run_still(scenario())
    assert asked >= 2
    assert later == asked, f"asked {later} times after the reader left, not {asked}"


# ── Over HTTP ───────────────────────────────────────────────────────────


def served(body: str, *, content_type: str = "application/json", etag: str | None = None, status: int = 200) -> Answer:
    """What the launcher's stand-in answers one read with."""
    headers = {"Content-Type": content_type} if etag is None else {"Content-Type": content_type, "ETag": etag}
    return Answer(status=status, headers=headers, body=body.encode())


def test_a_document_that_has_not_changed_is_not_read_again() -> None:
    async def scenario() -> tuple[DiscoveryRead, DiscoveryRead, DiscoveryRead, list[str | None]]:
        async with GatewayServer() as gateway:
            gateway.scripted[("GET", PATH)] = [
                served(document(entry("localhost", 4000, A)), etag='"v1"'),
                Answer(status=304, body=b""),
                # A new document has a new tag, and is read.
                served(document(), content_type="application/json; charset=utf-8", etag='"v2"'),
            ]
            reader = http_discovery(f"{gateway.origin}{PATH}")
            reads = await reader.read(), await reader.read(), await reader.read()
            return *reads, [asked.headers.get("if-none-match") for asked in gateway.of("GET", PATH)]

    first, second, third, tags = run(scenario())
    assert first == Managed(kbs=(kb(entry("localhost", 4000, A)),))
    assert second == Unchanged()
    assert third == Managed(kbs=())
    assert tags == [None, '"v1"', '"v1"']


def test_what_is_not_a_document_at_the_address_is_absent() -> None:
    async def scenario() -> tuple[list[DiscoveryRead], list[str | None], DiscoveryRead]:
        async with GatewayServer() as gateway:
            gateway.scripted[("GET", PATH)] = [
                # A server that answers every path with its own page.
                served("<!doctype html>", content_type="text/html", etag='"page"'),
                served("<!doctype html>", content_type="text/html", etag='"page"'),
                served("", content_type="text/plain", status=404),
                served("{", etag='"bad"'),
                served("{", etag='"bad"'),
            ]
            reader = http_discovery(f"{gateway.origin}{PATH}")
            reads = [await reader.read() for _ in range(5)]
            tags = [asked.headers.get("if-none-match") for asked in gateway.of("GET", PATH)]
        nowhere = await http_discovery(f"http://127.0.0.1:9{PATH}").read()
        return reads, tags, nowhere

    reads, tags, nowhere = run(scenario())
    assert [read.reason if isinstance(read, Absent) else read for read in reads] == [
        "not-found",
        "not-found",
        "not-found",
        "not-json",
        "not-json",
    ]
    # The tag of a document that did not read was not kept: it is not believed the next time.
    assert tags == [None, None, None, None, None]
    assert isinstance(nowhere, Absent)
    assert nowhere.reason == "unreadable"


def test_a_launchers_document_that_is_never_served_is_unreadable_at_the_deadline() -> None:
    async def scenario() -> tuple[DiscoveryRead, float]:
        async with GatewayServer() as gateway:
            gateway.scripted[("GET", PATH)] = [Answer(hold=True)]
            reader = http_discovery(f"{gateway.origin}{PATH}")
            loop = asyncio.get_running_loop()
            started = loop.time()
            read = await hurried(reader.read())
            return read, loop.time() - started

    read, took = run(scenario())
    deadline = HTTP_REQUEST_TIMEOUT_MS / 1000
    assert deadline <= took < deadline + 2, f"took {took}s"
    assert read == Absent(reason="unreadable", diagnostic="the document was not served within 30s")
