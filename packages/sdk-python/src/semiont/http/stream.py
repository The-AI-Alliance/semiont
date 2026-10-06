"""The stream (`docs/protocol/TRANSPORT-HTTP.md` § The client).

One task owns the subscription, the connections that carry it, and the state
they add up to.

A client holds one live stream. Two things replace it, and they are different
things:

- A **drop**: the stream ended, or a connect failed with none live. For a
  while frames are not delivered, the state leaves `open`, and the stream is
  opened again on a backoff, naming each scope's last position and the replies
  still awaited.
- A **handoff**: the subscription changed. A second connection is opened beside
  the live one and takes over once it is open. The old one keeps being read
  for `linger_ms` and is closed then. Nothing is missed, so the state stays
  `open`.

While both connections of a handoff are read, a frame is delivered once: the
ids of the last frames delivered are remembered, and a frame whose id is among
them is dropped.

Connections are tasks that only read. Everything they read comes back to this
one task, in order, so the state has one writer.
"""

import asyncio
import logging
from collections import OrderedDict
from dataclasses import dataclass
from typing import Final, final

import httpx
from pydantic import JsonValue, ValidationError

from semiont import telemetry
from semiont.channels import RESOURCE_SCOPED_CHANNELS
from semiont.errors import SemiontError, TransportError
from semiont.events import Broadcast
from semiont.http.sse import SseParser
from semiont.identifiers import ResourceId
from semiont.retry import RetryPolicy, equal_jitter, retry_after_ms
from semiont.timing import (
    DEGRADED_THRESHOLD_MS,
    EMIT_RETRY,
    HTTP_REQUEST_TIMEOUT_MS,
    LAZY_REMOVE_MS,
    LINGER_MS,
    MAX_RECONNECT_MS,
    RECONNECT_DEBOUNCE_MS,
    RECONNECT_MS,
    SEEN_EVENT_IDS_COUNT,
)
from semiont.transport import CONNECTION_STATE_MAY_BECOME, ConnectionState, Frame, FrameHub, ReplyRouter, TraceContext
from semiont.types import BusFrame, BusSubscribeRequest, ErrorResponse, ScopedItem
from semiont.watched import Variable, Watched

__all__ = ["SeenIds", "Stream", "Timing", "backoff_cap_ms"]

_LOG: Final = logging.getLogger("semiont.http")

# Where a frame's payload carries the trace it was sent under. It is the wire's, and no reader of the frame sees it.
_TRACE_FIELD: Final = "_trace"


def _sent_under(carried: JsonValue) -> TraceContext | None:
    """The trace a frame's payload says it was sent under, when it says so."""
    if not isinstance(carried, dict):
        return None
    traceparent, tracestate = carried.get("traceparent"), carried.get("tracestate")
    if not isinstance(traceparent, str):
        return None
    return TraceContext(traceparent=traceparent, tracestate=tracestate if isinstance(tracestate, str) and tracestate else None)


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Timing:
    """The timing a transport keeps: `specs/src/client/timing.json`'s, unless a caller that must not wait it out says otherwise."""

    reconnect_ms: int = RECONNECT_MS
    lazy_remove_ms: int = LAZY_REMOVE_MS
    linger_ms: int = LINGER_MS
    emit_retry: RetryPolicy = EMIT_RETRY
    seen_event_ids_count: int = SEEN_EVENT_IDS_COUNT
    http_request_ms: int = HTTP_REQUEST_TIMEOUT_MS
    """The deadline on one request that is neither the stream nor an emit."""


def backoff_cap_ms(reconnect_ms: int, failures: int) -> int:
    """The longest wait before the next connect, after `failures` in a row: `reconnect_ms` doubled per failure, up to `MAX_RECONNECT_MS`."""
    if reconnect_ms >= MAX_RECONNECT_MS:
        return MAX_RECONNECT_MS
    # Past this many doublings the cap is the ceiling whatever the base.
    doublings = min(failures, MAX_RECONNECT_MS.bit_length())
    return min(reconnect_ms << doublings, MAX_RECONNECT_MS)


@final
class _Carried(BusFrame, frozen=True, extra="ignore"):
    """A frame as a stream carries it, read by what it means.

    One a later gateway adds a field to is still a frame. One whose channel,
    payload or scope is not what a frame's is, is not.
    """


@final
class SeenIds:
    """The ids of the frames delivered last."""

    def __init__(self, capacity: int) -> None:
        self._capacity = capacity
        self._ids: OrderedDict[str, None] = OrderedDict()

    def remember(self, event_id: str) -> bool:
        """Remember `event_id`. False when it was already remembered: its frame has been delivered."""
        if event_id in self._ids:
            return False
        self._ids[event_id] = None
        if len(self._ids) > self._capacity:
            self._ids.popitem(last=False)
        return True


# What a connection, the transport's caller, or the token's owner reports to the stream's task.


@final
@dataclass(frozen=True, slots=True)
class _Opened:
    """The subscribe response is streaming."""

    conn: int


@final
@dataclass(frozen=True, slots=True)
class _Framed:
    """An event of the stream, with the id it came under."""

    conn: int
    id: str | None
    data: str


@final
@dataclass(frozen=True, slots=True)
class _Refused:
    """The gateway answered the connect, and not with a stream."""

    conn: int
    error: TransportError


@final
@dataclass(frozen=True, slots=True)
class _Ended:
    """The connect got no answer, or the stream ended."""

    conn: int


@final
@dataclass(frozen=True, slots=True)
class _ScopeTaken:
    """A resource's scope got its first hold."""

    resource: ResourceId


@final
@dataclass(frozen=True, slots=True)
class _ScopeLetGo:
    """A resource's scope lost its last hold."""

    resource: ResourceId


@final
@dataclass(frozen=True, slots=True)
class _TokenChanged:
    """The token is another one than it was."""


@final
@dataclass(frozen=True, slots=True)
class _Stop:
    """The transport is closing."""


type _Report = _Opened | _Framed | _Refused | _Ended | _ScopeTaken | _ScopeLetGo | _TokenChanged


@final
@dataclass(frozen=True, slots=True)
class _Connection:
    task: asyncio.Task[None]
    token: str
    """The token the connect sent: what is remembered if it is refused."""
    keep_previous: bool
    """Whether it was opened beside a live stream, to take over from it."""
    previous: tuple[int, ...]
    """The connections it retires once it is open."""


@final
class Stream:
    """A transport's stream: what it is subscribed to, the connections that carry it, and its state."""

    def __init__(
        self,
        *,
        base_url: str,
        http: httpx.AsyncClient,
        token: Watched[str | None],
        client_id: str,
        channels: tuple[str, ...],
        timing: Timing,
        hub: FrameHub,
        router: ReplyRouter,
        failures: Broadcast[SemiontError],
    ) -> None:
        self._base_url = base_url
        self._http = http
        self._token = token
        self._client_id = client_id
        self._global = channels
        self._timing = timing
        self._hub = hub
        self._router = router
        self._failures = failures

        self._state: Variable[ConnectionState] = Variable("initial")
        self._reports: asyncio.Queue[_Report | _Stop] = asyncio.Queue()
        self._running = False

        self._scoped: dict[ResourceId, tuple[str, ...]] = {}
        """The subscription's scoped half: each scope held, and its channels."""
        self._watermarks: dict[ResourceId, str] = {}
        """The last recorded event delivered on each scope. A scope keeps its
        position after it is let go: taken again, it resumes from there."""
        self._seen = SeenIds(timing.seen_event_ids_count)

        self._next_conn = 0
        self._connections: dict[int, _Connection] = {}
        self._live: int | None = None
        """The connection whose stream is the client's own. While there is one the state is `open`."""
        self._connecting: int | None = None
        """The connect not yet answered. Changes of subscription asked for
        meanwhile are served by one follow-up once it opens."""
        self._reconnect_owed = False
        self._superseded: set[int] = set()
        """Connections a handoff retired: still read, until their linger ends."""
        self._lingering: list[tuple[float, tuple[int, ...]]] = []

        self._failed_connects = 0
        """How many connects have failed since the last open."""
        self._refused_token: str | None = None
        """The token the gateway refused: never sent again."""
        self._awaiting_credential = False

        self._retry_at: tuple[float, bool] | None = None
        self._debounce_at: float | None = None
        self._lazy_at: float | None = None
        self._degraded_at: float | None = None

    @property
    def state(self) -> Watched[ConnectionState]:
        """The connection's state."""
        return self._state

    def take_scope(self, resource: ResourceId) -> None:
        """A resource's scope got its first hold."""
        self._reports.put_nowait(_ScopeTaken(resource))

    def let_go_of_scope(self, resource: ResourceId) -> None:
        """A resource's scope lost its last hold."""
        self._reports.put_nowait(_ScopeLetGo(resource))

    def stop(self) -> None:
        """Close: the state is `closed` from now, and the stream's task ends what it started."""
        self._closed()
        self._reports.put_nowait(_Stop())

    def _closed(self) -> None:
        """Nothing more is delivered: the state is `closed`, every reader's frames end, and every reply awaited will not come."""
        self._running = False
        self._state.set("closed")
        self._state.end()
        self._hub.close()
        self._router.close()

    async def run(self) -> None:
        """Hold the client's stream until `stop`. Every task it started has ended when it returns."""
        loop = asyncio.get_running_loop()
        try:
            async with asyncio.TaskGroup() as tasks:
                watching = tasks.create_task(self._watch_token())
                while True:
                    try:
                        async with asyncio.timeout_at(self._next_deadline()):
                            report = await self._reports.get()
                    except TimeoutError:
                        self._timers(tasks, loop.time())
                        continue
                    if isinstance(report, _Stop):
                        break
                    self._reported(tasks, report, loop.time())
                watching.cancel()
                for connection in self._connections.values():
                    connection.task.cancel()
        finally:
            # However its task ended, by `stop` or not, the stream is over.
            self._closed()
            self._connections.clear()

    # ── what is reported ─────────────────────────────────────────────────

    def _reported(self, tasks: asyncio.TaskGroup, report: _Report, now: float) -> None:
        match report:
            case _Opened(conn):
                self._opened(tasks, conn, now)
            case _Framed(conn, event_id, data):
                self._framed(conn, event_id, data)
            case _Refused(conn, error):
                self._refused(tasks, conn, error, now)
            case _Ended(conn):
                self._ended(tasks, conn, now)
            case _ScopeTaken(resource):
                self._scoped[resource] = RESOURCE_SCOPED_CHANNELS
                # A new scope needs to be live now: additions are gathered for
                # the debounce, and carry any removal waiting with them.
                self._lazy_at = None
                self._debounce_at = now + RECONNECT_DEBOUNCE_MS / 1000
            case _ScopeLetGo(resource):
                if self._scoped.pop(resource, None) is not None and self._debounce_at is None and self._lazy_at is None:
                    # A removal only narrows what is delivered, so it waits: a
                    # client that brushes past scopes would otherwise reopen
                    # its stream at each.
                    self._lazy_at = now + self._timing.lazy_remove_ms / 1000
            case _TokenChanged():
                self._token_changed(tasks, now)

    async def _watch_token(self) -> None:
        async for _ in self._token:
            self._reports.put_nowait(_TokenChanged())

    def _current_token(self) -> str | None:
        return self._token.value or None

    def _transition(self, to: ConnectionState, now: float) -> None:
        current = self._state.value
        if to == current or to not in CONNECTION_STATE_MAY_BECOME[current]:
            return
        # A stream that stays down is degraded once it has been reconnecting
        # for the threshold: the timer runs while the state is `reconnecting`.
        self._degraded_at = now + DEGRADED_THRESHOLD_MS / 1000 if to == "reconnecting" else None
        self._state.set(to)

    def _schedule_retry(self, after_ms: float, keep_previous: bool, now: float) -> None:
        if self._running:
            self._retry_at = (now + after_ms / 1000, keep_previous)

    def _backoff_ms(self) -> float:
        """Equal-jitter exponential backoff: a wait in [cap/2, cap]."""
        cap = backoff_cap_ms(self._timing.reconnect_ms, self._failed_connects)
        self._failed_connects += 1
        return equal_jitter(cap)

    def _abort(self, conn: int) -> None:
        connection = self._connections.pop(conn, None)
        if connection is not None:
            connection.task.cancel()
        self._superseded.discard(conn)

    # ── connecting ───────────────────────────────────────────────────────

    def _connect(self, tasks: asyncio.TaskGroup, keep_previous: bool, now: float) -> None:
        # A connect with no token cannot succeed, and neither can one that
        # sends again the token the gateway just refused. Neither is
        # attempted: the client waits, with no request, for a different one.
        token = self._current_token()
        if token is None or token == self._refused_token:
            if self._running:
                # With a stream still live the state stays `open`: only the
                # change of subscription is waiting for a credential.
                if self._live is None:
                    self._transition("unauthenticated", now)
                self._awaiting_credential = True
                self._schedule_retry(self._timing.reconnect_ms, keep_previous, now)
            return
        self._refused_token = None
        self._awaiting_credential = False

        previous = tuple(self._connections)
        if not keep_previous:
            # An initial connect, or the recovery of a drop: nothing live is worth keeping.
            for conn in previous:
                self._abort(conn)
            self._live = None
            self._lingering.clear()
        # Opening beside a live stream is a handoff, and the state stays `open`. With none, this is `connecting`.
        if self._live is None:
            self._transition("connecting", now)

        awaited = self._router.awaited()
        body = BusSubscribeRequest(
            client_id=self._client_id,
            global_=list(self._global),
            scoped=[
                ScopedItem(scope=scope, channels=list(channels), last_event_id=self._watermarks.get(scope))
                for scope, channels in sorted(self._scoped.items())
            ],
            pending_replies=awaited or None,
        )
        conn = self._next_conn
        self._next_conn += 1
        self._connections[conn] = _Connection(
            task=tasks.create_task(self._connection(conn, token, body)),
            token=token,
            keep_previous=keep_previous,
            previous=previous if keep_previous else (),
        )
        self._connecting = conn

    def _reconnect(self, tasks: asyncio.TaskGroup, now: float) -> None:
        """A changed subscription: hand it to a new stream. The live one is not touched, and the state does not move."""
        if not self._running:
            return
        if self._connecting is not None:
            self._reconnect_owed = True
            return
        self._retry_at = None
        self._connect(tasks, True, now)

    def _settle_connect(self, tasks: asyncio.TaskGroup, conn: int, opened: bool, now: float) -> None:
        """The connect `conn` made is answered.

        Opened, it serves the changes asked for while it was in flight with
        one follow-up. Failed, it leaves them to the retry, which reads the
        same subscription.
        """
        if self._connecting != conn:
            return
        self._connecting = None
        owed, self._reconnect_owed = self._reconnect_owed, False
        if opened and owed and self._running:
            self._reconnect(tasks, now)

    def _opened(self, tasks: asyncio.TaskGroup, conn: int, now: float) -> None:
        connection = self._connections.get(conn)
        if connection is None:
            return
        if connection.keep_previous:
            # The new stream is established, so the ones it replaces are
            # retired by drain: read for `linger_ms` more, then closed. Closing
            # them now would discard what they have received and not yet
            # delivered.
            previous = tuple(retired for retired in connection.previous if retired in self._connections)
            self._superseded.update(previous)
            self._lingering.append((now + self._timing.linger_ms / 1000, previous))
        self._live = conn
        self._transition("open", now)
        self._failed_connects = 0
        self._settle_connect(tasks, conn, True, now)

    def _framed(self, conn: int, event_id: str | None, data: str) -> None:
        if conn not in self._connections:
            return
        if event_id is not None and not self._seen.remember(event_id):
            return
        try:
            carried = _Carried.model_validate_json(data)
        except ValidationError as error:
            # What is not a frame is not delivered, and is said so.
            _LOG.warning("the stream carried what is not a frame (id %s): %s", event_id, error)
            return
        payload = carried.payload
        sent_under: TraceContext | None = None
        if _TRACE_FIELD in payload:
            sent_under = _sent_under(payload[_TRACE_FIELD])
            payload = {name: value for name, value in payload.items() if name != _TRACE_FIELD}
        frame = Frame(
            channel=carried.channel,
            payload=payload,
            correlation_id=carried.correlation_id,
            scope=carried.scope,
            trace=telemetry.received(carried.channel, carried.scope, sent_under),
        )
        self._router.route(frame)
        # A scope's position is the last recorded event delivered on it: only
        # a recorded event's id (`p-…`) is one, and it always comes on its scope.
        if event_id is not None and frame.scope is not None and event_id.startswith("p-"):
            self._watermarks[frame.scope] = event_id
        self._hub.deliver(frame)

    def _refused(self, tasks: asyncio.TaskGroup, conn: int, error: TransportError, now: float) -> None:
        connection = self._connections.pop(conn, None)
        if connection is None:
            return
        self._settle_connect(tasks, conn, False, now)
        # A refused connect is a request the gateway refused, reported as one.
        # A connect that got no answer is not: it is a state.
        self._failures.deliver(error)
        superseded = conn in self._superseded
        self._superseded.discard(conn)
        if error.status == 401 and self._running and not superseded:
            # Sending this token again gets the same answer, so it is not sent
            # again: the client waits for a different one.
            self._refused_token = connection.token
            self._failed_connects = 0
            if self._live is None:
                self._transition("unauthenticated", now)
            self._awaiting_credential = True
            self._schedule_retry(self._timing.reconnect_ms, connection.keep_previous, now)
            return
        self._dropped_or_failed(conn, superseded, error.retry_after_ms or 0, now)

    def _ended(self, tasks: asyncio.TaskGroup, conn: int, now: float) -> None:
        if self._connections.pop(conn, None) is None:
            return
        self._settle_connect(tasks, conn, False, now)
        superseded = conn in self._superseded
        self._superseded.discard(conn)
        self._dropped_or_failed(conn, superseded, 0, now)

    def _dropped_or_failed(self, conn: int, superseded: bool, stated_wait_ms: int, now: float) -> None:
        """A stream ended, or a connect failed. A superseded connection ending is expected and restarts nothing."""
        if not self._running or superseded:
            return
        if self._live is not None and self._live != conn:
            # A handoff that could not open. The stream it was to replace is
            # still live, so nothing has dropped: it is tried again on the
            # backoff, and the state does not move.
            self._schedule_retry(max(self._backoff_ms(), stated_wait_ms), True, now)
            return
        # A drop.
        self._live = None
        self._transition("reconnecting", now)
        if self._connecting is not None:
            # A handoff's connect is in flight: it is the recovery now, and comes back through here if it fails.
            self._transition("connecting", now)
            return
        self._schedule_retry(max(self._backoff_ms(), stated_wait_ms), False, now)

    def _token_changed(self, tasks: asyncio.TaskGroup, now: float) -> None:
        if not self._running:
            # The stream starts when there is a token to open it with.
            if self._state.value == "initial" and self._current_token() is not None:
                self._running = True
                self._connect(tasks, False, now)
            return
        # A client waiting for a credential tries at once.
        if self._awaiting_credential and self._retry_at is not None:
            self._retry_at = (now, self._retry_at[1])

    # ── time ─────────────────────────────────────────────────────────────

    def _next_deadline(self) -> float | None:
        deadlines = [
            deadline
            for deadline in (
                None if self._retry_at is None else self._retry_at[0],
                self._debounce_at,
                self._lazy_at,
                self._degraded_at,
                min((at for at, _ in self._lingering), default=None),
            )
            if deadline is not None
        ]
        return min(deadlines, default=None)

    def _timers(self, tasks: asyncio.TaskGroup, now: float) -> None:
        if self._degraded_at is not None and self._degraded_at <= now:
            self._degraded_at = None
            if self._state.value == "reconnecting":
                self._state.set("degraded")
        over = [conns for at, conns in self._lingering if at <= now]
        self._lingering = [(at, conns) for at, conns in self._lingering if at > now]
        for conns in over:
            for conn in conns:
                self._abort(conn)
        debounced = self._debounce_at is not None and self._debounce_at <= now
        lazy = self._lazy_at is not None and self._lazy_at <= now
        if debounced or lazy:
            self._debounce_at = None
            self._lazy_at = None
            self._reconnect(tasks, now)
        if self._retry_at is not None and self._retry_at[0] <= now:
            keep_previous = self._retry_at[1]
            self._retry_at = None
            if self._running:
                self._connect(tasks, keep_previous, now)

    # ── one connection ───────────────────────────────────────────────────

    async def _connection(self, conn: int, token: str, body: BusSubscribeRequest) -> None:
        """One connection: the subscribe request, and every event its stream carries, reported in order."""
        request = self._http.stream(
            "POST",
            f"{self._base_url}/bus/subscribe",
            content=body.model_dump_json(exclude_none=True),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "text/event-stream"},
        )
        try:
            async with request as response:
                if not response.is_success:
                    self._reports.put_nowait(_Refused(conn, await _refusal(response)))
                    return
                self._reports.put_nowait(_Opened(conn))
                parser = SseParser()
                async for read in response.aiter_bytes():
                    for event in parser.feed(read):
                        if event.event == "bus-event" and event.data != "":
                            self._reports.put_nowait(_Framed(conn, event.id, event.data))
        except httpx.HTTPError:
            # No answer, or a stream that broke: a state, reported as the stream's end.
            pass
        self._reports.put_nowait(_Ended(conn))


async def _refusal(response: httpx.Response) -> TransportError:
    """The gateway's refusal of a connect: its status, in its own words when its body states them."""
    status = response.status_code
    try:
        said = f": {ErrorResponse.model_validate_json(await response.aread()).error}"
    except (ValidationError, httpx.HTTPError):
        said = ""
    return TransportError.of_status(f"SSE connect failed: {status}{said}", status, retry_after_ms(response.headers.get("retry-after")))
