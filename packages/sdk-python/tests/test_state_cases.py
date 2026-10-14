"""The state units against `specs/src/client/state-units.json`.

Each case of a unit this SDK has is run as the table states it: its units are
built over a scripted transport, driven step by step, and held to what the case
says they hold and said. A unit that the names table
(`specs/src/client/surface.json`, `stateUnits`) says this SDK lacks has its
cases left unrun, as the surface test leaves a row's `absent` SDK: they run
once the unit lands and its `absent` goes. What the table may say is held by
`scripts/lint/check-state-unit-cases.mjs`; what a case cannot say, the axioms,
each unit's own test holds.
"""

import asyncio
import copy
import re
from collections.abc import Callable, Mapping
from typing import Final

import pytest
from aio import pass_time, run, turns
from pydantic import JsonValue
from spec import SPEC, JsonObject, objects, read, strings, text

from semiont import timing
from semiont.channels import BRIDGED_CHANNELS
from semiont.client import SemiontClient
from semiont.errors import SemiontError
from semiont.model import WireModel, written
from semiont.state import MatchStateUnit
from semiont.state_unit import StateUnit
from semiont.testing import Delay, DropReply, FaultAction, FaultyTransport, create_test_client, refuse_unscripted_operation
from semiont.transport import Frame, Transport
from semiont.watched import Watched

# The SDK this runner is, as the names table's `absent` names it.
SDK: Final = "python"

TABLE: Final = read(SPEC / "client/state-units.json")
NAMES: Final = read(SPEC / "client/surface.json")

type Client = SemiontClient[Transport]
type Make = Callable[[Client, JsonObject], StateUnit]

MAKERS: Final[Mapping[str, Make]] = {
    "match": lambda client, made: MatchStateUnit(client),
}
"""How this SDK makes each unit it has, from the client and what the case makes it from."""


def units_this_sdk_has() -> set[str]:
    has: set[str] = set()
    for row in objects(NAMES["stateUnits"], "stateUnits"):
        absent = row.get("absent", {})
        assert isinstance(absent, dict)
        if SDK not in absent:
            has.add(text(row["unit"], "a unit"))
    return has


HAS: Final = units_this_sdk_has()
CASES: Final = objects(TABLE["cases"], "cases")
RUN: Final = [case for case in CASES if text(case["unit"], "a case's unit") in HAS]


def fixture(name: str) -> JsonValue:
    fixtures = TABLE["fixtures"]
    assert isinstance(fixtures, dict)
    assert name in fixtures, f"the table has no fixture {name}"
    return fixtures[name]


def resolved(value: JsonValue) -> JsonValue:
    """`value` with each `{"$fixture": name}` replaced by the table's fixture."""
    if isinstance(value, list):
        return [resolved(item) for item in value]
    if isinstance(value, dict):
        if list(value) == ["$fixture"]:
            return resolved(fixture(text(value["$fixture"], "a fixture's name")))
        return {key: resolved(item) for key, item in value.items()}
    return value


def payload(value: JsonValue) -> dict[str, JsonValue]:
    stated = resolved(value)
    assert isinstance(stated, dict), "a payload is an object"
    return stated


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def duration_ms(value: JsonValue) -> float:
    """A duration as the table states it, in milliseconds."""
    if isinstance(value, int):
        return value
    assert isinstance(value, dict), "a duration is milliseconds, or a timing"
    base: object = getattr(timing, snake(text(value["timing"], "a timing")).upper())
    assert isinstance(base, int), f"{value['timing']} is no duration of this SDK's timing"
    times = value.get("times", 1)
    plus = value.get("plusMs", 0)
    assert isinstance(times, int | float)
    assert isinstance(plus, int)
    return base * times + plus


# ── The transport ───────────────────────────────────────────────────────


def _never(operation: str, asked: Mapping[str, JsonValue]) -> JsonValue:
    """Nothing: the reply this answers with is dropped on its way, and a step answers instead."""
    del operation, asked
    return None


def _jobs(operation: str, asked: Mapping[str, JsonValue]) -> JsonValue:
    match operation:
        case "job:create":
            return {"jobId": "job-1"}
        case "job:status-requested":
            return {
                "jobId": "job-1",
                "type": "mark",
                "status": "running",
                "userId": "did:web:example.org:users:alice",
                "created": "2026-10-01T00:00:00.000Z",
            }
        case _:
            refuse_unscripted_operation(operation, asked)


def transport_of(stated: JsonValue) -> FaultyTransport:
    """The transport a case states. Its stream carries what a client's does: the replies and the broadcasts, never the requests."""
    assert isinstance(stated, dict)
    answers = text(stated["answers"], "transport.answers")
    delay = stated.get("delayMs")
    schedule: list[FaultAction] = [] if delay is None else [Delay(ms=round(duration_ms(delay)))]
    match answers:
        case "never":
            assert delay is None, "a transport that never answers holds no reply"
            transport = FaultyTransport([DropReply()], make_response=_never, channels=BRIDGED_CHANNELS)
        case "refuses":
            transport = FaultyTransport(schedule, channels=BRIDGED_CHANNELS)
        case "jobs":
            transport = FaultyTransport(schedule, make_response=_jobs, channels=BRIDGED_CHANNELS)
        case _:
            raise AssertionError(f"no transport answers {answers}")
    replies = stated.get("replies", {})
    assert isinstance(replies, dict)
    for operation, responses in replies.items():
        assert isinstance(responses, list)
        transport.queue_reply(operation, [resolved(response) for response in responses])
    return transport


# ── What a unit holds, as the wire writes it ────────────────────────────


def wire(held: object) -> JsonValue:
    """What a state holds, as the wire writes it. An error is its code and its message."""
    if isinstance(held, WireModel):
        return written(held)
    if isinstance(held, SemiontError):
        return {"code": held.code, "message": held.message}
    if held is None or isinstance(held, str | bool | int | float):
        return held
    raise AssertionError(f"a state holds {held!r}, which this runner cannot write as the wire does")


def matches(expected: JsonValue, actual: JsonValue) -> bool:
    """Whether `actual` is what `expected` states: exactly, but where `$has` asks only for some members."""
    if isinstance(expected, dict) and list(expected) == ["$has"]:
        has = expected["$has"]
        assert isinstance(has, dict)
        return isinstance(actual, dict) and all(key in actual and matches(value, actual[key]) for key, value in has.items())
    if isinstance(expected, dict):
        return (
            isinstance(actual, dict)
            and expected.keys() == actual.keys()
            and all(matches(value, actual[key]) for key, value in expected.items())
        )
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(expected) == len(actual)
            and all(matches(one, other) for one, other in zip(expected, actual, strict=True))
        )
    if isinstance(expected, bool) or isinstance(actual, bool):
        return expected is actual
    return expected == actual


def holds(expected: JsonValue, held: object) -> bool:
    """Whether a state holds what `expected` states. An error is compared on what the case states of it."""
    if isinstance(held, SemiontError):
        assert isinstance(expected, dict), f"the state holds an error, {held!r}, and the case states {expected!r}"
        written_error = wire(held)
        assert isinstance(written_error, dict)
        return all(key in written_error and written_error[key] == value for key, value in expected.items())
    return matches(resolved(expected), wire(held))


def state_of(units: Mapping[str, StateUnit], name: str, member: str) -> Watched[object]:
    """The state a unit's member holds, read by the member's name."""
    state: Watched[object] = getattr(units[name], snake(member))
    return state


class _End:
    """What a reader gives once it has ended."""


_END: Final = _End()


async def has_ended(state: Watched[object]) -> bool:
    """Whether a reader of `state` is given what it holds and then ends."""
    readers = aiter(state)
    await anext(readers)
    rest = asyncio.ensure_future(anext(readers, _END))
    await turns()
    if not rest.done():
        rest.cancel()
        await asyncio.gather(rest, return_exceptions=True)
        return False
    return rest.result() is _END


# ── A case, played ──────────────────────────────────────────────────────


async def play(case: JsonObject) -> None:
    unit_kind = text(case["unit"], "a case's unit")
    transport = transport_of(case["transport"])
    made = create_test_client(transport=transport)
    client = made.client
    made_from = case["made"]
    assert isinstance(made_from, dict)
    async with client:
        units: dict[str, StateUnit] = {}
        for name, given in made_from.items():
            assert isinstance(given, dict)
            units[name] = MAKERS[unit_kind](client, given)
        heard: list[Frame] = []
        listening = strings(case.get("listen", []), "listen")

        async def collect() -> None:
            async with client.bus.frames_among(listening) as frames:
                async for frame in frames:
                    heard.append(frame)

        collector = asyncio.ensure_future(collect()) if listening else None
        steps = case["steps"]
        assert isinstance(steps, list)
        told = 0
        try:
            for at, step in enumerate(steps):
                try:
                    told = await perform(step, client, transport, units, heard, told)
                except AssertionError as broken:
                    raise AssertionError(f"steps[{at}] {step}: {broken}") from broken
        finally:
            for unit in units.values():
                unit.dispose()
            if collector is not None:
                collector.cancel()
                await asyncio.gather(collector, return_exceptions=True)
            await turns()


def request_id(transport: FaultyTransport, named: JsonValue) -> str | None:
    """The correlation id the `nth` request sent on a channel carried."""
    assert isinstance(named, dict)
    channel, nth = text(named["sent"], "a request's channel"), named["nth"]
    assert isinstance(nth, int)
    sent = [entry for entry in transport.request_log if entry.channel == channel]
    assert len(sent) > nth, f"request #{nth} on {channel} was not sent"
    return sent[nth].correlation_id


async def perform(
    step: JsonValue, client: Client, transport: FaultyTransport, units: Mapping[str, StateUnit], heard: list[Frame], told: int
) -> int:
    """Perform one step. Returns how much of what was heard has been checked."""
    if step == "settle":
        await turns()
        return told
    assert isinstance(step, dict)
    if "say" in step:
        correlation = step.get("correlationId")
        assert correlation is None or isinstance(correlation, str)
        client.bus.emit(text(step["say"], "a channel"), payload(step["payload"]), correlation_id=correlation)
    elif "deliver" in step:
        correlation = step.get("correlationId")
        assert correlation is None or isinstance(correlation, str)
        transport.deliver(Frame(channel=text(step["deliver"], "a channel"), payload=payload(step["payload"]), correlation_id=correlation))
    elif "answer" in step:
        asked = request_id(transport, {"sent": step["answer"], "nth": step["nth"]})
        transport.deliver(Frame(channel=text(step["reply"], "a reply's channel"), payload=payload(step["payload"]), correlation_id=asked))
    elif "queueReply" in step:
        transport.queue_reply(text(step["queueReply"], "an operation"), [resolved(step["response"])])
    elif "invoke" in step:
        args = step["args"]
        assert isinstance(args, dict)
        method: Callable[..., object] = getattr(units[text(step["of"], "a unit")], snake(text(step["invoke"], "a member")))
        method(**{snake(name): resolved(value) for name, value in args.items()})
    elif "pass" in step:
        await pass_time(duration_ms(step["pass"]) / 1000)
    elif "dispose" in step:
        units[text(step["dispose"], "a unit")].dispose()
    elif "expect" in step:
        expected = step["expect"]
        assert isinstance(expected, dict)
        for name, members in expected.items():
            assert isinstance(members, dict)
            for member, value in members.items():
                held = state_of(units, name, member).value
                assert holds(value, held), f"{name}.{member} holds {wire(held)!r}, not {value!r}"
    elif "sent" in step:
        channel = text(step["sent"], "a request's channel")
        sent: list[JsonValue] = [dict(entry.payload) for entry in transport.request_log if entry.channel == channel]
        if "count" in step:
            assert len(sent) == step["count"], f"{len(sent)} requests were sent on {channel}, not {step['count']}"
        else:
            assert matches(resolved(step["payloads"]), sent), f"sent on {channel}: {sent!r}"
    elif "nothingSent" in step:
        assert list(transport.request_log) == [], f"requests were sent: {list(transport.request_log)!r}"
    elif "heard" in step:
        await turns()
        frames = heard[told:]
        stated = step["heard"]
        assert isinstance(stated, list)
        got = [{"channel": frame.channel, "payload": dict(frame.payload), "correlationId": frame.correlation_id} for frame in frames]
        assert len(stated) == len(got), f"heard {got!r}"
        for wanted, frame in zip(stated, frames, strict=True):
            assert isinstance(wanted, dict)
            correlation = wanted.get("correlationId")
            expected_id = request_id(transport, correlation) if isinstance(correlation, dict) else correlation
            assert frame.channel == wanted["channel"], f"heard {got!r}"
            assert matches(resolved(wanted["payload"]), dict(frame.payload)), f"heard {got!r}"
            assert frame.correlation_id == expected_id, f"heard {got!r}"
        return len(heard)
    elif "ended" in step:
        ended = step["ended"]
        assert isinstance(ended, dict)
        for name, members in ended.items():
            for member in strings(members, "ended"):
                assert await has_ended(state_of(units, name, member)), f"{name}.{member} has not ended"
    elif "busDestroyed" in step:
        assert client.bus.destroyed is step["busDestroyed"], f"the client's bus is{'' if client.bus.destroyed else ' not'} destroyed"
    else:
        raise AssertionError("no step this runner performs")
    return told


# ── The tests ───────────────────────────────────────────────────────────


def test_this_sdk_makes_each_unit_it_has_and_no_other() -> None:
    assert set(MAKERS) == HAS


def test_every_case_is_of_a_unit_the_names_table_has() -> None:
    named = {text(row["unit"], "a unit") for row in objects(NAMES["stateUnits"], "stateUnits")}
    assert {text(case["unit"], "a case's unit") for case in CASES} <= named


@pytest.mark.parametrize("case", RUN, ids=[f"{case['unit']}: {case['case']}" for case in RUN])
def test_a_unit_does_what_its_case_says(case: JsonObject) -> None:
    run(play(case))


def test_the_runner_fails_a_case_whose_check_is_wrong() -> None:
    told = copy.deepcopy(next(case for case in RUN if case["unit"] == "match"))
    steps = told["steps"]
    assert isinstance(steps, list)
    for step in steps:
        if isinstance(step, dict) and "heard" in step:
            step["heard"] = []
    with pytest.raises(AssertionError, match="heard"):
        run(play(told))
