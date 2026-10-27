"""The bus log: with `SEMIONT_BUS_LOG` set, a line on stdout for each frame a transport sends or receives, each read and each upload.

Every Semiont SDK writes it, in one form, so that the lines of several
processes read as one timeline (`docs/protocol/EVENT-BUS.md` § Wire format).
The form is held here, and so is each place a transport writes one. A line
never holds a credential: what a line shows of a payload is the table every
bus log runs (`specs/src/bus/log-cases.json`), which lists the names a
credential is withheld under.
"""

import re
from collections.abc import Generator, Iterator
from typing import Final, TypeAliasType, get_args

import pytest
from aio import run, settle, soon
from gateway_server import Answer, GatewayServer
from pydantic import JsonValue, TypeAdapter
from shown import CARRIED, parts_of
from spec import PACKAGE, SPEC, JsonObject, objects, read, strings, text

from semiont import model, telemetry
from semiont._bus_log import bus_log, bus_note, enabled
from semiont.channels import CHANNELS
from semiont.errors import SemiontError
from semiont.http import HttpTransport, Timing
from semiont.identifiers import ResourceId
from semiont.model import WireModel
from semiont.retry import RetryPolicy
from semiont.transport import PutBinaryRequest, TraceContext
from semiont.watched import Variable, reached

QUICK: Final = Timing(
    reconnect_ms=10, lazy_remove_ms=10, linger_ms=10, emit_retry=RetryPolicy(attempts=2, initial_delay_ms=1, max_delay_ms=1)
)
RESOURCE: Final = ResourceId("res-1")
CORRELATION: Final = "a89a670a-1b2c-4d3e-8f90-123456789abc"
TRACE: Final = TraceContext(traceparent="00-8f3ca4ed5a6b7c8d9e0f112233445566-b7ad6b7169203331-01")


@pytest.fixture
def logging_the_bus(monkeypatch: pytest.MonkeyPatch) -> Generator[None]:
    """The variable set, for a process that has not yet read it."""
    monkeypatch.setenv("SEMIONT_BUS_LOG", "1")
    enabled.cache_clear()
    yield
    enabled.cache_clear()


@pytest.fixture
def not_logging_the_bus(monkeypatch: pytest.MonkeyPatch) -> Generator[None]:
    """The variable not set, for a process that has not yet read it."""
    monkeypatch.delenv("SEMIONT_BUS_LOG", raising=False)
    enabled.cache_clear()
    yield
    enabled.cache_clear()


def written(capsys: pytest.CaptureFixture[str]) -> list[str]:
    """Every line written to stdout so far."""
    return capsys.readouterr().out.splitlines()


# ── a line ──────────────────────────────────────────────────────────────


@pytest.mark.usefixtures("logging_the_bus")
def test_a_line_is_the_operation_the_channel_and_the_payload_as_json_all_on_one_line_of_stdout(
    capsys: pytest.CaptureFixture[str],
) -> None:
    bus_log(
        "EMIT",
        "beckon:focus",
        {"resourceId": "res-1", "annotationId": "a-1", "said": "two\nlines", "naïve": [1, {"left": None, "right": True}]},
    )
    captured = capsys.readouterr()
    assert captured.out == (
        '[bus EMIT] beckon:focus {"resourceId":"res-1","annotationId":"a-1","said":"two\\nlines","naïve":[1,{"left":null,"right":true}]}\n'
    )
    assert captured.err == ""


@pytest.mark.usefixtures("logging_the_bus")
def test_a_line_says_the_scope_the_first_eight_of_the_correlation_id_and_of_the_trace_each_where_there_is_one(
    capsys: pytest.CaptureFixture[str],
) -> None:
    bus_log("RECV", "mark:added", {}, scope=RESOURCE)
    bus_log("EMIT", "job:claim", {}, correlation_id=CORRELATION)
    # A correlation id that is nothing is none.
    bus_log("EMIT", "job:claim", {}, correlation_id="")
    with telemetry.continuing(TRACE):
        bus_log("EMIT", "job:start", {})
        bus_log("RECV", "mark:added", {"n": 1}, scope=RESOURCE, correlation_id=CORRELATION)
    assert written(capsys) == [
        "[bus RECV] mark:added scope=res-1 {}",
        "[bus EMIT] job:claim cid=a89a670a {}",
        "[bus EMIT] job:claim {}",
        "[bus EMIT] job:start trace=8f3ca4ed {}",
        '[bus RECV] mark:added scope=res-1 cid=a89a670a trace=8f3ca4ed {"n":1}',
    ]


@pytest.mark.usefixtures("logging_the_bus")
def test_a_note_is_a_line_about_a_channel_that_is_no_frame(capsys: pytest.CaptureFixture[str]) -> None:
    bus_note("LINGER", "beckon:focus", "delivered on superseded connection")
    assert written(capsys) == ["[bus LINGER] beckon:focus delivered on superseded connection"]


@pytest.mark.usefixtures("not_logging_the_bus")
def test_unset_nothing_is_written(capsys: pytest.CaptureFixture[str]) -> None:
    bus_log("EMIT", "beckon:focus", {"resourceId": "res-1", "annotationId": "a-1"})
    bus_note("LINGER", "beckon:focus", "delivered on superseded connection")
    assert capsys.readouterr().out == ""


@pytest.mark.parametrize(("value", "lines"), [("", 0), ("1", 1), ("0", 1), ("false", 1), (" ", 1)])
def test_set_is_any_value_that_is_not_empty(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], value: str, lines: int
) -> None:
    monkeypatch.setenv("SEMIONT_BUS_LOG", value)
    enabled.cache_clear()
    try:
        bus_log("EMIT", "beckon:focus", {"resourceId": "res-1"})
        assert len(written(capsys)) == lines
    finally:
        enabled.cache_clear()


def test_the_variable_is_read_once_when_the_first_line_would_be_written(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("SEMIONT_BUS_LOG", "1")
    enabled.cache_clear()
    try:
        bus_log("EMIT", "beckon:focus", {"resourceId": "res-1"})
        # What the process is started with decides: the variable changed afterwards changes nothing.
        monkeypatch.delenv("SEMIONT_BUS_LOG")
        bus_log("EMIT", "beckon:focus", {"resourceId": "res-1"})
        assert len(written(capsys)) == 2
    finally:
        enabled.cache_clear()


@pytest.mark.usefixtures("logging_the_bus")
def test_the_lines_the_readme_shows_are_lines_the_log_writes(capsys: pytest.CaptureFixture[str]) -> None:
    bus_log("EMIT", "job:claim", {"accepts": [{"jobType": "yield"}]}, correlation_id=CORRELATION)
    bus_log("RECV", "job:claim-failed", {"code": "none-pending", "message": "No pending job matches"}, correlation_id=CORRELATION)
    shown = (PACKAGE / "README.md").read_text(encoding="utf-8")
    lines = written(capsys)
    assert len(lines) == 2
    for line in lines:
        assert f"\n{line}\n" in shown


# ── a credential ────────────────────────────────────────────────────────

TABLE: Final = read(SPEC / "bus/log-cases.json")
NAMES: Final = strings(TABLE["names"], "the names")
CASES: Final = objects(TABLE["cases"], "the cases")
JSON: Final = TypeAdapter[JsonValue](JsonValue)


def payload_of(case: JsonObject) -> JsonObject:
    """A case's payload, which is an object: what a frame carries, and what this log is given."""
    payload = case["payload"]
    assert isinstance(payload, dict), f"{case['why']}: its payload is no object"
    return payload


def shown_of(payload: JsonObject, capsys: pytest.CaptureFixture[str]) -> JsonValue:
    """What the line this log writes of `payload` shows of it."""
    # The rule reads a name and no channel: every line here is written on this one.
    bus_log("EMIT", "yield:clone-create", payload)
    line = capsys.readouterr().out
    said = "[bus EMIT] yield:clone-create "
    assert line.startswith(said)
    assert line.endswith("\n")
    return JSON.validate_json(line.removeprefix(said))


@pytest.mark.usefixtures("logging_the_bus")
@pytest.mark.parametrize("case", CASES, ids=lambda case: str(case["why"]))
def test_a_line_shows_of_a_payload_what_the_table_says(case: JsonObject, capsys: pytest.CaptureFixture[str]) -> None:
    assert shown_of(payload_of(case), capsys) == case["shown"]


@pytest.mark.usefixtures("logging_the_bus")
@pytest.mark.parametrize("name", NAMES)
def test_the_value_of_a_member_under_each_name_of_the_table_is_withheld(name: str, capsys: pytest.CaptureFixture[str]) -> None:
    # The names this log withholds under are its own list, and the table's is the one it is held to.
    assert shown_of({name: "a-credential", "beside": "shown"}, capsys) == {name: "[withheld]", "beside": "shown"}


def test_the_table_has_cases_that_carry_a_credential_and_cases_that_carry_none() -> None:
    carrying = [case for case in CASES if case["payload"] != case["shown"]]
    assert 0 < len(carrying) < len(CASES)


def withheld_under(payload: JsonValue, shown: JsonValue) -> Iterator[str]:
    """The names a case withholds under: that of each member it shows as withheld, wherever in the payload the member is."""
    if isinstance(payload, dict) and isinstance(shown, dict):
        for name, member in payload.items():
            if shown[name] == "[withheld]" and member != "[withheld]":
                yield name
            else:
                yield from withheld_under(member, shown[name])
    elif isinstance(payload, list) and isinstance(shown, list):
        for member, as_shown in zip(payload, shown, strict=True):
            yield from withheld_under(member, as_shown)


def test_the_tables_cases_withhold_under_each_of_its_names_and_under_no_other() -> None:
    assert len(set(NAMES)) == len(NAMES)
    assert {name for case in CASES for name in withheld_under(case["payload"], case["shown"])} == set(NAMES)
    # And what the table says of its names, in words, names each of them.
    said = text(TABLE["$comment"], "what the table says of itself")
    assert [name for name in NAMES if f"`{name}`" not in said] == []


@pytest.mark.parametrize("case", [case for case in CASES if "channel" in case], ids=lambda case: str(case["channel"]))
def test_a_case_that_names_a_channel_is_a_payload_that_channel_carries(case: JsonObject) -> None:
    # What the spec states of the three payloads that carry the token is the spec's: a case that restates one is
    # held to it here, so a payload that comes to name its token otherwise fails until the table and the rule follow.
    channel = CHANNELS[text(case["channel"], "a channel")]
    payload = payload_of(case)
    assert model.written(channel.decode(payload)) == payload


def shapes_within(named: object) -> Iterator[type[WireModel]]:
    """The shapes a member's type names, however it names them."""
    if isinstance(named, type):
        if issubclass(named, WireModel):
            yield named
        return
    if isinstance(named, TypeAliasType):
        yield from shapes_within(named.__value__)
        return
    for part in get_args(named):
        yield from shapes_within(part)


def members_of(shape: type[WireModel], seen: set[type[WireModel]]) -> Iterator[tuple[str, str]]:
    """Every member `shape` declares, and every member of the shapes its members name: each with the shape that declares it."""
    if shape in seen:
        return
    seen.add(shape)
    for name, field in shape.model_fields.items():
        yield shape.__name__, field.alias or name
        for inner in shapes_within(field.annotation):
            yield from members_of(inner, seen)


def test_every_member_a_bus_payload_declares_whose_name_reads_as_a_credential_s_is_one_the_log_withholds_or_is_known_to_be_none() -> None:
    # The log withholds the value of a member whose name is one of the table's. Nothing in the spec marks a member as
    # a credential, so the rule is held to the names the spec uses: a payload that comes to declare a member whose name
    # reads as one fails here until it is decided which it is, a name of the table or one named below as none.
    reads_as_one = re.compile(r"token|secret|password|credential|key|auth", re.IGNORECASE)
    # Every name of the table reads as one: a member declared under any of them is one this walk finds.
    assert [name for name in NAMES if not reads_as_one.search(name)] == []
    declared: dict[tuple[str, str], set[str]] = {}
    walked = 0
    for name, channel in CHANNELS.items():
        seen: set[type[WireModel]] = set()
        for shape in channel.members:
            for owner, member in members_of(shape, seen):
                walked += 1
                if reads_as_one.search(member):
                    declared.setdefault((owner, member), set()).add(name)
    assert walked > 500, "the walk read next to nothing: this gate holds nothing"
    credentials = {place: channels for place, channels in declared.items() if place[1] in NAMES}
    # The payloads declare one credential, the token a resource is cloned by, in three places.
    assert credentials == {
        ("YieldCloneResourceRequest", "token"): {"yield:clone-resource-requested"},
        ("YieldCloneCreateCommand", "token"): {"yield:clone-create"},
        ("CloneResourceWithTokenResponse", "token"): {"yield:clone-token-generated"},
    }
    # And each channel that carries one is a case of the table, as the channel carries it.
    assert {text(case["channel"], "a channel") for case in CASES if "channel" in case} == set[str]().union(*credentials.values())
    # The rest count a model's tokens, and are no credential.
    assert {member for _, member in declared.keys() - credentials.keys()} == {"maxTokens", "contextTokens", "maxOutputTokens"}


# ── where a transport writes one ────────────────────────────────────────

CHANNELS_NAMED: Final = ("beckon:focus",)


def transport_to(gateway: GatewayServer, timing: Timing = QUICK) -> HttpTransport:
    return HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=CHANNELS_NAMED, timing=timing)


async def opened(transport: HttpTransport) -> None:
    await soon(reached(transport.state, lambda state: state == "open"))


@pytest.mark.usefixtures("logging_the_bus")
def test_a_transport_writes_a_line_for_each_frame_it_sends(capsys: pytest.CaptureFixture[str]) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway, transport_to(gateway) as transport:
            await opened(transport)
            await transport.emit("beckon:focus", {"resourceId": "res-1", "annotationId": "a-1"}, correlation_id=CORRELATION)
            await transport.emit("beckon:focus", {"resourceId": "res-1", "annotationId": "a-2"}, scope=RESOURCE)
            with telemetry.continuing(TRACE):
                await transport.emit("beckon:focus", {"resourceId": "res-1"})
            assert len(gateway.emits) == 3

    run(scenario())
    assert written(capsys) == [
        '[bus EMIT] beckon:focus cid=a89a670a {"resourceId":"res-1","annotationId":"a-1"}',
        '[bus EMIT] beckon:focus scope=res-1 {"resourceId":"res-1","annotationId":"a-2"}',
        '[bus EMIT] beckon:focus trace=8f3ca4ed {"resourceId":"res-1"}',
    ]


@pytest.mark.usefixtures("logging_the_bus")
def test_an_emit_the_gateway_refuses_is_a_line_all_the_same_and_one_however_many_times_it_is_made(
    capsys: pytest.CaptureFixture[str],
) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway, transport_to(gateway) as transport:
            await opened(transport)
            gateway.scripted["POST", "/bus/emit"] = [Answer(status=503, body=b"{}"), Answer(status=503, body=b"{}")]
            with pytest.raises(SemiontError):
                await transport.emit("beckon:focus", {"resourceId": "res-1", "annotationId": "a-1"})
            assert len(gateway.emits) == 2

    run(scenario())
    assert written(capsys) == ['[bus EMIT] beckon:focus {"resourceId":"res-1","annotationId":"a-1"}']


@pytest.mark.usefixtures("logging_the_bus")
def test_a_transport_writes_a_line_for_each_frame_it_receives_as_the_frame_carried_it_and_none_for_what_it_does_not_deliver(
    capsys: pytest.CaptureFixture[str],
) -> None:
    carried: dict[str, JsonValue] = {
        "resourceId": "res-1",
        "annotationId": "a-1",
        "_userId": "did:web:example.org:users:a",
        "_trace": {"traceparent": TRACE.traceparent},
    }

    async def scenario() -> None:
        async with GatewayServer() as gateway, transport_to(gateway) as transport:
            await opened(transport)
            frames = transport.frames("beckon:focus")
            gateway.send("e-1", {"channel": "beckon:focus", "payload": carried, "correlationId": CORRELATION, "scope": "res-1"})
            # The same frame again, what is no frame, and an event that is no frame's: none is delivered, and none is a line.
            gateway.send("e-1", {"channel": "beckon:focus", "payload": carried, "correlationId": CORRELATION, "scope": "res-1"})
            gateway.send("e-2", {"payload": {"annotationId": "a-2"}})
            gateway.write("event: ping\ndata:\n\n")
            # A channel nobody here reads is received all the same.
            gateway.send("e-3", {"channel": "mark:added", "payload": {}})
            gateway.send("e-4", {"channel": "beckon:focus", "payload": {"resourceId": "res-1"}})
            assert [(await soon(anext(frames))).payload for _ in range(2)] == [
                {"resourceId": "res-1", "annotationId": "a-1", "_userId": "did:web:example.org:users:a"},
                {"resourceId": "res-1"},
            ]

    run(scenario())
    assert written(capsys) == [
        '[bus RECV] beckon:focus scope=res-1 cid=a89a670a {"resourceId":"res-1","annotationId":"a-1",'
        '"_userId":"did:web:example.org:users:a","_trace":{"traceparent":"00-8f3ca4ed5a6b7c8d9e0f112233445566-b7ad6b7169203331-01"}}',
        "[bus RECV] mark:added {}",
        '[bus RECV] beckon:focus {"resourceId":"res-1"}',
    ]


@pytest.mark.usefixtures("logging_the_bus")
def test_a_frame_a_retired_connection_delivers_is_noted_as_one(capsys: pytest.CaptureFixture[str]) -> None:
    # A stream that takes over from another leaves the other read for a while. What that one still delivers is what
    # closing it at once would have lost.
    lingering = Timing(reconnect_ms=10, lazy_remove_ms=10, linger_ms=60_000)

    async def scenario() -> None:
        async with GatewayServer() as gateway, transport_to(gateway, lingering) as transport:
            await opened(transport)
            frames = transport.frames("beckon:focus")
            with transport.subscribe_to_resource(RESOURCE):
                await soon(gateway.streams(2))
                # The second stream has taken over once its opening has been read.
                await settle()
                # With no id nothing tells the two copies apart, so each stream delivers its own.
                gateway.send(None, {"channel": "beckon:focus", "payload": {"resourceId": "res-1", "annotationId": "a-1"}})
                for _ in range(2):
                    await soon(anext(frames))

    run(scenario())
    assert sorted(written(capsys)) == [
        "[bus LINGER] beckon:focus delivered on superseded connection",
        '[bus RECV] beckon:focus {"resourceId":"res-1","annotationId":"a-1"}',
        '[bus RECV] beckon:focus {"resourceId":"res-1","annotationId":"a-1"}',
    ]


@pytest.mark.usefixtures("logging_the_bus")
def test_a_read_of_content_and_an_upload_are_each_a_line_that_says_what_was_asked_and_none_of_the_bytes(
    capsys: pytest.CaptureFixture[str],
) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway, transport_to(gateway) as transport:
            gateway.stored["res-1"] = ("text/plain", b"what the resource says")
            gateway.anchored_texts["res-1"] = {"kind": "not-yet"}
            created = await transport.content.put_binary(
                PutBinaryRequest(
                    name="A name",
                    file=b"what is uploaded",
                    format="text/plain",
                    storage_uri="file://uploads/a-name.txt",
                    clone_token=CARRIED,
                )
            )
            assert created.resource_id == "res-uploaded-1"
            assert (await transport.content.get_binary(RESOURCE)).data == b"what the resource says"
            async with await transport.content.get_binary_stream(RESOURCE) as stream:
                assert b"".join([piece async for piece in stream]) == b"what the resource says"
            assert (await transport.content.get_anchored_text(RESOURCE)).kind == "not-yet"
            # A read that is refused was asked for all the same.
            with pytest.raises(SemiontError):
                await transport.content.get_resource_graph(ResourceId("res-absent"))

    run(scenario())
    captured = capsys.readouterr().out
    assert captured.splitlines() == [
        '[bus PUT] content {"name":"A name","format":"text/plain","storageUri":"file://uploads/a-name.txt","sizeBytes":16}',
        '[bus GET] content {"resourceId":"res-1"}',
        '[bus GET] content {"resourceId":"res-1","stream":true}',
        '[bus GET] content {"resourceId":"res-1","anchoredText":true}',
        '[bus GET] content {"resourceId":"res-absent","graph":true}',
    ]
    # The token a clone is made with goes in the upload, and in no line.
    assert parts_of(CARRIED, captured) == []
    assert "what is uploaded" not in captured


@pytest.mark.usefixtures("not_logging_the_bus")
def test_unset_a_transport_writes_nothing(capsys: pytest.CaptureFixture[str]) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway, transport_to(gateway) as transport:
            await opened(transport)
            frames = transport.frames("beckon:focus")
            gateway.stored["res-1"] = ("text/plain", b"what the resource says")
            await transport.emit("beckon:focus", {"resourceId": "res-1", "annotationId": "a-1"})
            gateway.send("e-1", {"channel": "beckon:focus", "payload": {"resourceId": "res-1"}})
            await soon(anext(frames))
            await transport.content.get_binary(RESOURCE)
            await transport.content.put_binary(PutBinaryRequest(name="n", file=b"b", format="text/plain", storage_uri="file://n.txt"))

    run(scenario())
    assert capsys.readouterr().out == ""
