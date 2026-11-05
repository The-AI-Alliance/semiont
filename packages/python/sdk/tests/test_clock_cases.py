"""The time a client keeps, against `protocol/specs/src/client/clock-cases.json`.

Each case builds its subject over a network faked in this process, on a loop
whose clock moves only when the case moves it (`aio.StillLoop`), at this SDK's
timings, which are the table's, and with the lowest draw the jitter's random
source can give. A `pass` stops the clock at each instant a timer falls due,
in turn, and lets what falls due run there, so a wait ends at the instant it
was set to end, or the case fails. What the table may say is held by
`.github/scripts/checks/specs/check-case-tables.mjs`.
"""

import asyncio
import copy
import random
import re
from collections import Counter
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine, Mapping, Sequence
from contextlib import AsyncExitStack
from dataclasses import dataclass
from typing import Final, Literal, NoReturn, Self, final, override

import httpx
import pytest
from aio import StillLoop, run_still, turns
from kb import RESOURCE, asked_for, event, knowing, knowing_content
from pydantic import JsonValue, TypeAdapter
from spec import SPEC, JsonObject, objects, read, strings, text
from tokens import token

from semiont import retry, timing
from semiont.cache import Cache, CachePersister, Runs
from semiont.channels import BRIDGED_CHANNELS
from semiont.claims import ClaimRefusal
from semiont.client import SemiontClient
from semiont.discovery import DiscoveryRead, DiscoveryTransport, Managed, Unchanged, subscribe_discovery
from semiont.errors import TransportError
from semiont.http.oauth import sign_in_with_device_grant
from semiont.http.transport import HttpTransport
from semiont.session import HeldSignIn, MemorySignIn, SemiontSession
from semiont.testing import FaultyTransport, InMemoryContent, StubGateway, create_test_client, refuse_unscripted_operation
from semiont.transport import Frame
from semiont.types import DiscoveredKB, HighlightingJobParams, HttpEndpoint, JobFilter, JobProgress, KbTarget, UserResponse
from semiont.watched import Variable, Watched

TABLE: Final = read(SPEC / "client/clock-cases.json")
CASES: Final = objects(TABLE["cases"], "cases")

SETTLE_TURNS: Final = 200
"""How many turns of the loop a settle lets pass: enough for what any case sets going to run as far as it can without the clock moving."""

AT_ONCE_TURNS: Final = 10 * SETTLE_TURNS
"""How many turns of the loop a piece of work that is to end without the clock moving is given to end in: room for settles of its own."""

SAME_INSTANT_S: Final = 1e-6
"""How near, in seconds, a timer falls due to an instant a case names for it to fall due at that instant.

A deadline is the instant it was set at plus its wait, and a case's instant is
where the case began plus all it has passed: sums made in different orders,
which can differ in their last places, and never by a millisecond.
"""


async def settle() -> None:
    """Let what is ready run, and what that makes ready, without moving the clock."""
    await turns(SETTLE_TURNS)


async def at_once[T](work: Awaitable[T]) -> T:
    """`work`, which is to end with what is ready, the clock not moving.

    A still clock never ends a wait, so a `work` that waits for time fails
    here, where an `await` of it would wait for ever.
    """
    task = asyncio.ensure_future(work)
    for _ in range(AT_ONCE_TURNS):
        if task.done():
            return task.result()
        await asyncio.sleep(0)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    raise AssertionError("it did not end without the clock moving")


@final
class Clock:
    """A case's clock: where it stands, in whole milliseconds since the case began."""

    def __init__(self) -> None:
        loop = asyncio.get_running_loop()
        assert isinstance(loop, StillLoop), "a case is run by `run_still`"
        self._loop: Final = loop
        self._began: Final = loop.time()
        self.at_ms = 0

    async def pass_ms(self, ms: int) -> None:
        """Settle, then move the clock `ms` ahead: to each instant a timer falls due on the way, in turn, and what falls due runs there."""
        assert ms >= 0, "a case passes no time backwards"
        await settle()
        self.at_ms += ms
        until = self._began + self.at_ms / 1000
        while (due := self._loop.next_due()) is not None and due <= until + SAME_INSTANT_S:
            self._loop.move_to(due)
            await settle()
        if until > self._loop.time():
            self._loop.move_to(until)
            await settle()


@final
class LowestDraw(random.Random):
    """A random source whose every draw is the lowest it can give."""

    @override
    def random(self) -> float:
        return 0.0


# ── Durations ───────────────────────────────────────────────────────────


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def timing_ms(name: str) -> int:
    """A duration `protocol/specs/src/client/timing.json` names, as this SDK keeps it.

    A retry budget's member follows its budget and a `.`.
    """
    budget, _, member = name.partition(".")
    kept: object = getattr(timing, snake(budget).upper())
    if member:
        kept = getattr(kept, snake(member))
    assert isinstance(kept, int), f"{name} is no duration of this SDK's timing"
    return kept


def duration_ms(value: JsonValue) -> int:
    """A duration as the table states it, in milliseconds: a whole number of them."""
    if isinstance(value, int):
        return value
    assert isinstance(value, dict), "a duration is milliseconds, or a timing"
    times = value.get("times", 1)
    plus = value.get("plusMs", 0)
    assert isinstance(times, int | float)
    assert isinstance(plus, int)
    scaled = timing_ms(text(value["timing"], "a timing")) * times + plus
    assert scaled == int(scaled), f"{value} is not a whole number of milliseconds"
    return int(scaled)


# ── What a case drives ──────────────────────────────────────────────────


@final
@dataclass(frozen=True, slots=True)
class Subject:
    """What a case drives: what it counts, and its action, when it has one."""

    counted: Callable[[], int]
    act: Callable[[], Awaitable[object]] | None


type Build = Callable[[JsonObject, AsyncExitStack], Awaitable[Subject]]
"""How a subject is built, from what the case's `given` states, with what is to be closed once the case is over put on the stack."""


async def cancelled(task: asyncio.Task[object]) -> None:
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


def running(held: AsyncExitStack, work: Coroutine[object, object, object]) -> asyncio.Task[object]:
    """`work` set going, and cancelled once the case is over."""
    task = asyncio.ensure_future(work)
    held.push_async_callback(cancelled, task)
    return task


def tally[T](held: AsyncExitStack, watched: Watched[T], counts: Callable[[T], bool]) -> Callable[[], int]:
    """How many of the values `watched` has come to hold `counts` counts, from now on.

    A reader of a changing value is given the latest when it reads, so two
    changes between its reads are read as one: each count of a case comes
    after a settle, in which the reader reads every change before it.
    """
    seen = 0

    async def read() -> None:
        nonlocal seen
        async for value in watched:
            if counts(value):
                seen += 1

    running(held, read())
    return lambda: seen


def given_seconds(given: JsonObject, name: str) -> int | None:
    """A span of seconds the case's `given` states, when it states one."""
    value = given.get(name)
    assert value is None or isinstance(value, int), f"given.{name} is not a whole number of seconds"
    return value


# ── The gateway ─────────────────────────────────────────────────────────

GATEWAY: Final = "http://gateway.test"
SUBSCRIBE, EMIT, HEALTH = "/bus/subscribe", "/bus/emit", "/api/health"

type StreamAnswer = Literal["holds", "refuses", "never"]
"""How a gateway answers a subscribe: with a stream it holds open, with a 503, or not at all."""


async def never_answered() -> NoReturn:
    """Wait for an answer that never comes: until whoever waits is cancelled."""
    await asyncio.Event().wait()
    raise AssertionError("an event nobody can set was set")


@final
class HeldOpen(httpx.AsyncByteStream):
    """The body of a stream a gateway holds open and says nothing on. Its reader waits on it until it closes it."""

    def __init__(self, closed: Callable[[], None]) -> None:
        self._closed: Final = closed
        self._closing: Final = asyncio.Event()

    @override
    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> bytes:
        await self._closing.wait()
        raise StopAsyncIteration

    @override
    async def aclose(self) -> None:
        if not self._closing.is_set():
            self._closing.set()
            self._closed()


@final
class Gateway:
    """A gateway in this process. It answers each request at once, as the subject has it answer, and counts what it is asked."""

    def __init__(self, stream: StreamAnswer, *, retry_after_seconds: int | None, unanswered: frozenset[str]) -> None:
        self._stream: Final = stream
        self._retry_after_seconds: Final = retry_after_seconds
        self._unanswered: Final = unanswered
        self.asked: Final = Counter[str]()
        """How many requests of each path it has been asked."""
        self.closed = 0
        """How many of the streams it held open their readers have closed."""

    async def answer(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.asked[path] += 1
        if path in self._unanswered:
            await never_answered()
        if path != SUBSCRIBE:
            raise AssertionError(f"the gateway was asked {request.method} {path}, which this subject does not have it answer")
        if self._stream == "holds":
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=HeldOpen(self._closed_one))
        if self._stream == "refuses":
            stated = {} if self._retry_after_seconds is None else {"retry-after": str(self._retry_after_seconds)}
            return httpx.Response(503, headers=stated, json={"error": "The gateway is not ready"})
        return await never_answered()

    def _closed_one(self) -> None:
        self.closed += 1

    async def transport(self, held: AsyncExitStack) -> HttpTransport:
        """A transport to this gateway, open and holding a token, so its stream is set going."""
        http = await held.enter_async_context(httpx.AsyncClient(transport=httpx.MockTransport(self.answer), trust_env=False))
        return await held.enter_async_context(HttpTransport(GATEWAY, token=Variable[str | None]("a-token"), http=http))


async def refused_stream(given: JsonObject, held: AsyncExitStack) -> Subject:
    gateway = Gateway("refuses", retry_after_seconds=given_seconds(given, "retryAfterSeconds"), unanswered=frozenset())
    await gateway.transport(held)
    return Subject(counted=lambda: gateway.asked[SUBSCRIBE], act=None)


async def unanswered_stream(given: JsonObject, held: AsyncExitStack) -> Subject:
    gateway = Gateway("never", retry_after_seconds=None, unanswered=frozenset())
    await gateway.transport(held)
    return Subject(counted=lambda: gateway.asked[SUBSCRIBE], act=None)


async def degraded_stream(given: JsonObject, held: AsyncExitStack) -> Subject:
    gateway = Gateway("refuses", retry_after_seconds=given_seconds(given, "retryAfterSeconds"), unanswered=frozenset())
    transport = await gateway.transport(held)
    return Subject(counted=tally(held, transport.state, lambda state: state == "degraded"), act=None)


async def scope_taken(given: JsonObject, held: AsyncExitStack) -> Subject:
    gateway = Gateway("holds", retry_after_seconds=None, unanswered=frozenset())
    transport = await gateway.transport(held)

    async def take() -> None:
        held.enter_context(transport.subscribe_to_resource(RESOURCE))

    return Subject(counted=lambda: gateway.asked[SUBSCRIBE], act=take)


async def scope_let_go(given: JsonObject, held: AsyncExitStack) -> Subject:
    gateway = Gateway("holds", retry_after_seconds=None, unanswered=frozenset())
    transport = await gateway.transport(held)
    await settle()
    assert transport.state.value == "open", "the stream opened"
    hold = transport.subscribe_to_resource(RESOURCE)

    async def let_go() -> None:
        hold.release()

    return Subject(counted=lambda: gateway.asked[SUBSCRIBE], act=let_go)


async def handoff_linger(given: JsonObject, held: AsyncExitStack) -> Subject:
    gateway = Gateway("holds", retry_after_seconds=None, unanswered=frozenset())
    transport = await gateway.transport(held)

    async def take() -> None:
        held.enter_context(transport.subscribe_to_resource(RESOURCE))

    return Subject(counted=lambda: gateway.closed, act=take)


async def unanswered_request(given: JsonObject, held: AsyncExitStack) -> Subject:
    gateway = Gateway("holds", retry_after_seconds=None, unanswered=frozenset({HEALTH}))
    transport = await gateway.transport(held)
    asked = running(held, transport.health_check())

    def failed() -> int:
        if not asked.done():
            return 0
        error = asked.exception()
        assert isinstance(error, TransportError), f"the health check ended otherwise: {asked!r}"
        assert error.status is None, f"the health check was answered: {error!r}"
        return 1

    return Subject(counted=failed, act=None)


async def unanswered_emit(given: JsonObject, held: AsyncExitStack) -> Subject:
    gateway = Gateway("holds", retry_after_seconds=None, unanswered=frozenset({EMIT}))
    transport = await gateway.transport(held)
    # Its attempts are cut before the transport closes, which waits for every emit under way to end.
    running(held, transport.emit("beckon:hover", {"annotationId": "ann-1"}))
    return Subject(counted=lambda: gateway.asked[EMIT], act=None)


# ── The issuer ──────────────────────────────────────────────────────────

ISSUER: Final = "http://issuer.test/realms/semiont"


@final
class Issuer:
    """A knowledge base that trusts an issuer, and the issuer, in this process: what a device grant asks.

    It mints a code that lives 900 seconds, with the interval the case states,
    and answers each ask of its token endpoint with the next of `answers`, the
    last repeating.
    """

    def __init__(self, *, interval_seconds: int | None, answers: Sequence[str]) -> None:
        assert answers, "the token endpoint has answers"
        self._interval_seconds: Final = interval_seconds
        self._answers: Final = tuple(answers)
        self.token_asks = 0

    async def answer(self, request: httpx.Request) -> httpx.Response:
        where = f"{request.url.scheme}://{request.url.host}{request.url.path}"
        if where == f"{GATEWAY}/.well-known/oauth-protected-resource":
            return httpx.Response(
                200, json={"resource": GATEWAY, "authorization_servers": [ISSUER], "bearer_methods_supported": ["header"]}
            )
        if where == f"{ISSUER}/.well-known/openid-configuration":
            return httpx.Response(
                200,
                json={
                    "issuer": ISSUER,
                    "authorization_endpoint": f"{ISSUER}/auth",
                    "token_endpoint": f"{ISSUER}/token",
                    "device_authorization_endpoint": f"{ISSUER}/device",
                },
            )
        if where == f"{ISSUER}/device":
            minted: JsonObject = {
                "device_code": "the-device-code",
                "user_code": "WDJB-MJHT",
                "verification_uri": "http://issuer.test/device",
                "expires_in": 900,
            }
            if self._interval_seconds is not None:
                minted["interval"] = self._interval_seconds
            return httpx.Response(200, json=minted)
        if where == f"{ISSUER}/token":
            said = self._answers[min(self.token_asks, len(self._answers) - 1)]
            self.token_asks += 1
            return httpx.Response(400, json={"error": said})
        raise AssertionError(f"the issuer was asked {request.method} {where}, which a device grant does not ask")


async def device_grant(given: JsonObject, held: AsyncExitStack) -> Subject:
    issuer = Issuer(interval_seconds=given_seconds(given, "intervalSeconds"), answers=strings(given["answers"], "given.answers"))
    http = await held.enter_async_context(httpx.AsyncClient(transport=httpx.MockTransport(issuer.answer), trust_env=False))
    running(held, sign_in_with_device_grant(GATEWAY, lambda code: None, http=http))
    return Subject(counted=lambda: issuer.token_asks, act=None)


# ── A session ───────────────────────────────────────────────────────────

KB: Final = KbTarget(id="kb-alpha", label="Alpha", endpoint=HttpEndpoint(kind="http", host="localhost", port=4000, protocol="http"))
ALICE: Final = UserResponse.model_validate(
    {"did": "did:web:example.org:users:alice", "email": "alice@example.org", "name": "Alice", "image": None, "domain": "example.org"}
)


async def renewal(given: JsonObject, held: AsyncExitStack) -> Subject:
    lifetime = given_seconds(given, "lifetimeSeconds")
    assert lifetime is not None, "a renewal's case states how long its tokens live"
    renewals = 0

    async def renew() -> str | None:
        nonlocal renewals
        renewals += 1
        return token(lifetime, renewals)

    async def accepted(_token: str) -> UserResponse:
        return ALICE

    kept = MemorySignIn(
        HeldSignIn(access=token(lifetime, 0), refresh="a-refresh-token", client_id="semiont-cli", token_endpoint=f"{ISSUER}/token")
    )
    session = SemiontSession(
        kb=KB, client=create_test_client().client, token=Variable[str | None](None), kept=kept, refresh=renew, validate=accepted
    )
    await held.enter_async_context(session)
    return Subject(counted=lambda: renewals, act=None)


# ── A worker's claims ───────────────────────────────────────────────────

MARK_JOBS: Final = TypeAdapter[list[JobFilter]](list[JobFilter]).validate_python(
    [{"jobType": "mark", "params": {"motivation": "highlighting"}}]
)
CLAIMED: Final[JsonObject] = {
    "status": "running",
    "metadata": {
        "id": "job-1",
        "type": "mark",
        "userId": "did:web:example.org:users:alice",
        "created": "2026-10-01T00:00:00.000Z",
        "retryCount": 0,
        "maxRetries": 1,
    },
    "params": {"resourceId": "res-1"},
    "startedAt": "2026-10-01T00:00:01.000Z",
    "progress": {},
}


def dispatcher(operation: str, asked: Mapping[str, JsonValue]) -> JsonValue:
    """A dispatcher with one job: it answers `job:claim` with it."""
    if operation == "job:claim":
        return CLAIMED
    refuse_unscripted_operation(operation, asked)


async def held_job_stall(given: JsonObject, held: AsyncExitStack) -> Subject:
    transport = FaultyTransport(make_response=dispatcher)
    held.push_async_callback(transport.close)
    client = SemiontClient(transport, InMemoryContent(), StubGateway())
    held.push_async_callback(client.close)
    claims = await held.enter_async_context(client.job.claim(MARK_JOBS))
    job = await anext(claims)
    assert not isinstance(job, ClaimRefusal), job

    async def report() -> None:
        await job.progress(JobProgress(percentage=50))

    return Subject(counted=tally(held, claims.stalled, lambda stall: stall is not None), act=report)


# ── Discovery ───────────────────────────────────────────────────────────

MANAGED: Final = Managed(
    kbs=(
        DiscoveredKB.model_validate(
            {"host": "localhost", "port": 4000, "placement": "local", "managedBy": "semiont-launcher", "did": "did:web:example.org:kb-a"}
        ),
    )
)


@final
class LauncherDocument(DiscoveryTransport):
    """A launcher's document: one managed knowledge base at the first read, and unchanged at every read after it."""

    def __init__(self) -> None:
        self.reads = 0

    @override
    async def read(self) -> DiscoveryRead:
        self.reads += 1
        return MANAGED if self.reads == 1 else Unchanged()


async def discovery(given: JsonObject, held: AsyncExitStack) -> Subject:
    document = LauncherDocument()

    async def follow() -> None:
        async for _ in subscribe_discovery(document, timing.DISCOVERY_INTERVAL_MS / 1000):
            pass

    running(held, follow())
    return Subject(counted=lambda: document.reads, act=None)


# ── A client's queries and caches ───────────────────────────────────────


async def drained(values: AsyncIterator[object]) -> None:
    async for _ in values:
        pass


async def invalidation_window(given: JsonObject, held: AsyncExitStack) -> Subject:
    transport = FaultyTransport(make_response=knowing)
    client = SemiontClient(transport, knowing_content(), StubGateway())
    await held.enter_async_context(client)
    running(held, drained(await held.enter_async_context(client.browse.events(RESOURCE))))

    async def mark_added() -> None:
        transport.deliver(event("mark:added"))

    return Subject(counted=lambda: len(asked_for(transport, "browse:events-requested")), act=mark_added)


@final
class Saves(CachePersister[str, int]):
    """A cache's storage: it keeps nothing to begin with, and records each save."""

    def __init__(self) -> None:
        self.saved: Final[list[dict[str, int]]] = []

    @override
    def load(self) -> Mapping[str, int] | None:
        return None

    @override
    def save(self, entries: Mapping[str, int]) -> None:
        self.saved.append(dict(entries))


@final
class NothingRuns(Runs):
    """What runs the fetches of a cache that is only written: nothing is fetched."""

    @override
    def run[T](self, work: Coroutine[object, object, T]) -> asyncio.Task[T]:
        work.close()
        raise AssertionError("a cache that is only written fetched")


async def nothing_fetched(key: str) -> int:
    raise AssertionError(f"a cache that is only written fetched {key}")


async def save_debounce(given: JsonObject, held: AsyncExitStack) -> Subject:
    saves = Saves()
    cache = Cache[str, int](nothing_fetched, tasks=NothingRuns(), persister=saves)
    held.callback(cache.dispose)
    changes = 0

    async def change() -> None:
        nonlocal changes
        changes += 1
        cache.set("a key", changes)

    return Subject(counted=lambda: len(saves.saved), act=change)


JOB_RUNNING: Final[JsonObject] = {
    "jobId": "job-1",
    "type": "mark",
    "status": "running",
    "userId": "did:web:example.org:users:alice",
    "created": "2026-10-01T00:00:00.000Z",
}


def job_queue(operation: str, asked: Mapping[str, JsonValue]) -> JsonValue:
    """A job queue with one job, `job-1`, which it creates when asked and says is running whenever it is asked."""
    match operation:
        case "job:create":
            return {"jobId": "job-1"}
        case "job:status-requested":
            return JOB_RUNNING
        case _:
            return refuse_unscripted_operation(operation, asked)


async def job_follower(given: JsonObject, held: AsyncExitStack) -> Subject:
    transport = FaultyTransport(make_response=job_queue, channels=BRIDGED_CHANNELS)
    client = SemiontClient(transport, InMemoryContent(), StubGateway())
    await held.enter_async_context(client)

    async def follow() -> None:
        async for _ in client.mark.delegate(RESOURCE, HighlightingJobParams(motivation="highlighting")):
            pass

    running(held, follow())

    async def progressed() -> None:
        report: JsonObject = {"resourceId": "res-1", "jobId": "job-1", "jobType": "mark", "percentage": 10, "progress": {"percentage": 10}}
        transport.deliver(Frame(channel="job:report-progress", payload=report))

    return Subject(counted=lambda: len(asked_for(transport, "job:status-requested")), act=progressed)


SUBJECTS: Final[Mapping[str, Build]] = {
    "refusedStream": refused_stream,
    "unansweredStream": unanswered_stream,
    "degradedStream": degraded_stream,
    "scopeTaken": scope_taken,
    "scopeLetGo": scope_let_go,
    "handoffLinger": handoff_linger,
    "renewal": renewal,
    "deviceGrant": device_grant,
    "heldJobStall": held_job_stall,
    "discovery": discovery,
    "invalidationWindow": invalidation_window,
    "saveDebounce": save_debounce,
    "jobFollower": job_follower,
    "unansweredRequest": unanswered_request,
    "unansweredEmit": unanswered_emit,
}
"""How this SDK builds each subject the table names."""


# ── A case, played ──────────────────────────────────────────────────────


async def perform(step: JsonValue, subject: Subject, clock: Clock) -> None:
    if step == "settle":
        await settle()
    elif step == "act":
        assert subject.act is not None, "the subject has no action"
        await at_once(subject.act())
        await settle()
    elif isinstance(step, dict) and "pass" in step:
        await clock.pass_ms(duration_ms(step["pass"]))
    elif isinstance(step, dict) and "counted" in step:
        await settle()
        counted = subject.counted()
        assert counted == step["counted"], f"counted {counted}, not {step['counted']}"
    else:
        raise AssertionError("no step this runner performs")


async def play(case: JsonObject) -> None:
    given = case.get("given", {})
    assert isinstance(given, dict)
    steps = case["steps"]
    assert isinstance(steps, list)
    clock = Clock()
    held = AsyncExitStack()
    try:
        subject = await at_once(SUBJECTS[text(case["subject"], "a case's subject")](given, held))
        for at, step in enumerate(steps):
            try:
                await perform(step, subject, clock)
            except AssertionError as broken:
                raise AssertionError(f"steps[{at}] {step}, at {clock.at_ms} ms: {broken}") from broken
    finally:
        await at_once(held.aclose())


# ── The tests ───────────────────────────────────────────────────────────


def test_this_runner_builds_every_subject_the_table_names_and_no_other() -> None:
    assert set(SUBJECTS) == {text(case["subject"], "a case's subject") for case in CASES}


@pytest.mark.parametrize("case", CASES, ids=[f"{case['subject']}: {case['case']}" for case in CASES])
def test_a_wait_ends_when_its_case_says(case: JsonObject, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(retry, "random", LowestDraw())
    run_still(play(case))


def test_the_runner_fails_a_case_whose_wait_ends_a_millisecond_early(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(retry, "random", LowestDraw())
    told = copy.deepcopy(next(case for case in CASES if case["subject"] == "refusedStream"))
    steps = told["steps"]
    assert isinstance(steps, list)
    # The last millisecond of the first wait: the case is told the stream was opened again in it.
    assert steps[2] == {"counted": 1}
    steps[2] = {"counted": 2}
    with pytest.raises(AssertionError, match="steps\\[2\\]"):
        run_still(play(told))
