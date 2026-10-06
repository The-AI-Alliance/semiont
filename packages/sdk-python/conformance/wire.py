"""The wire driver: this SDK's transport, as `tests/conformance/sdk/wire` drives it.

It reaches the transport only as an application does, through what `semiont`
exports, so what the suite observes is what a caller of the SDK gets. An
operation the SDK has nothing for is not here, and is answered `unsupported`:
each wire case that asks for one is named in this SDK's line of `SDK_DRIVERS`
with why.
"""

import asyncio
import sys
from contextlib import AsyncExitStack
from typing import final

from protocol import Arguments, Misuse, Operation, count, failure, object_of, optional_text, say, serve, text, texts
from pydantic import JsonValue

from semiont.bus import request
from semiont.errors import SemiontError
from semiont.events import Events
from semiont.http import HttpTransport, Timing
from semiont.identifiers import InvalidIdentifier, ResourceId
from semiont.operations import OPERATIONS
from semiont.retry import RetryPolicy
from semiont.transport import ConnectionState, Frame, ResourceHold
from semiont.watched import Variable


def _resource(args: Arguments, name: str) -> ResourceId:
    try:
        return ResourceId(text(args, name))
    except InvalidIdentifier as error:
        raise Misuse(f"{name} is not a resource's id: {error}") from error


def _timing(stated: Arguments) -> Timing:
    """The timing a case states, each entry by its name in `specs/src/client/timing.json`."""
    known = Timing()
    reconnect_ms, lazy_remove_ms, linger_ms = known.reconnect_ms, known.lazy_remove_ms, known.linger_ms
    emit_retry, seen_event_ids_count = known.emit_retry, known.seen_event_ids_count
    for name in stated:
        match name:
            case "reconnectMs":
                reconnect_ms = count(stated, name)
            case "lazyRemoveMs":
                lazy_remove_ms = count(stated, name)
            case "lingerMs":
                linger_ms = count(stated, name)
            case "seenEventIdsCount":
                seen_event_ids_count = count(stated, name)
            case "emitRetry":
                budget = object_of(stated, name)
                emit_retry = RetryPolicy(
                    attempts=count(budget, "attempts"),
                    initial_delay_ms=count(budget, "initialDelayMs"),
                    max_delay_ms=count(budget, "maxDelayMs"),
                )
            case _:
                raise Misuse(f"this driver cannot override {name}")
    return Timing(
        reconnect_ms=reconnect_ms,
        lazy_remove_ms=lazy_remove_ms,
        linger_ms=linger_ms,
        emit_retry=emit_retry,
        seen_event_ids_count=seen_event_ids_count,
    )


@final
class Wire:
    """One transport, and what the suite asked it to report."""

    def __init__(self, held: AsyncExitStack, reporters: asyncio.TaskGroup) -> None:
        self._held = held
        self._reporters = reporters
        self._token: Variable[str | None] = Variable(None)
        self._transport: HttpTransport | None = None
        self._holds: dict[ResourceId, list[ResourceHold]] = {}
        self._reported: ConnectionState | None = None

    def _opened(self) -> HttpTransport:
        if self._transport is None:
            raise Misuse("no transport is open")
        return self._transport

    def _report(self, state: ConnectionState) -> None:
        if state != self._reported:
            self._reported = state
            say({"state": state})

    async def _states(self, transport: HttpTransport) -> None:
        async for state in transport.state:
            self._report(state)

    async def _failures(self, failures: Events[SemiontError]) -> None:
        async for error in failures:
            say({"error": failure(error)})

    async def _frames(self, channel: str, frames: Events[Frame]) -> None:
        async for frame in frames:
            line: dict[str, JsonValue] = {"channel": channel, "payload": dict(frame.payload)}
            if frame.correlation_id is not None:
                line["correlationId"] = frame.correlation_id
            if frame.scope is not None:
                line["scope"] = frame.scope
            say({"frame": line})

    async def open(self, _: int, args: Arguments) -> JsonValue:
        if self._transport is not None:
            raise Misuse("a transport is already open")
        timing = _timing(object_of(args, "timing") if "timing" in args else {})
        self._token.set(text(args, "token"))
        transport = HttpTransport(text(args, "baseUrl"), token=self._token, channels=texts(args, "channels"), timing=timing)
        self._transport = await self._held.enter_async_context(transport)
        self._reporters.create_task(self._states(transport))
        self._reporters.create_task(self._failures(transport.failures()))
        return None

    async def close(self, _: int, __: Arguments) -> JsonValue:
        await self._opened().close()
        return None

    async def set_token(self, _: int, args: Arguments) -> JsonValue:
        self._opened()
        self._token.set(text(args, "token"))
        return None

    async def listen(self, _: int, args: Arguments) -> JsonValue:
        channel = text(args, "channel")
        self._reporters.create_task(self._frames(channel, self._opened().frames(channel)))
        return None

    async def subscribe_resource(self, _: int, args: Arguments) -> JsonValue:
        resource = _resource(args, "resource")
        self._holds.setdefault(resource, []).append(self._opened().subscribe_to_resource(resource))
        return None

    async def release_resource(self, _: int, args: Arguments) -> JsonValue:
        resource = _resource(args, "resource")
        holds = self._holds.get(resource)
        if not holds:
            raise Misuse(f"nothing holds {resource}")
        holds.pop().release()
        return None

    async def emit(self, _: int, args: Arguments) -> JsonValue:
        subscribers = await self._opened().emit(
            text(args, "channel"),
            object_of(args, "payload"),
            scope=None if args.get("scope") is None else _resource(args, "scope"),
            correlation_id=optional_text(args, "correlationId"),
        )
        return {} if subscribers is None else {"subscribers": subscribers}

    async def request(self, _: int, args: Arguments) -> JsonValue:
        name = text(args, "operation")
        operation = OPERATIONS.get(name)
        if operation is None:
            raise Misuse(f"{name} is not an operation of the registry")
        result = await request(self._opened(), operation, object_of(args, "payload"), timeout_ms=count(args, "timeoutMs"))
        return {"response": result["response"]} if "response" in result else {}

    async def sync(self, _: int, __: Arguments) -> JsonValue:
        # Answers after everything the transport reported before it: the
        # suite's way to know it has read the state the connection is in.
        if self._transport is not None:
            self._report(self._transport.state.value)
        return None

    async def dispose(self) -> None:
        if self._transport is not None:
            await self._transport.close()

    def operations(self) -> dict[str, Operation]:
        return {
            "open": Operation(self.open, in_turn=True),
            "close": Operation(self.close, in_turn=True),
            "set-token": Operation(self.set_token, in_turn=True),
            "listen": Operation(self.listen, in_turn=True),
            "subscribe-resource": Operation(self.subscribe_resource, in_turn=True),
            "release-resource": Operation(self.release_resource, in_turn=True),
            "emit": Operation(self.emit),
            "request": Operation(self.request, abandonable=True),
            "sync": Operation(self.sync, in_turn=True),
        }


async def main() -> int:
    # The reporters end when the transport they read is closed, which `dispose` does.
    async with AsyncExitStack() as held, asyncio.TaskGroup() as reporters:
        wire = Wire(held, reporters)
        return await serve(wire.operations(), wire.dispose)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
