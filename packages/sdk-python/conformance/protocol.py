"""The driver protocol of `tests/conformance/sdk`, as a program speaks it.

A driver is a process. The suite writes one JSON object to its stdin per line
and reads one from its stdout per line. This is the part every driver shares:
it says it is ready, runs the operations it is asked for side by side, answers
each once, and when its stdin ends disposes of what it holds and exits 0. An
operation it has no way to perform is answered `unsupported` at once, before
the next is read.
"""

import asyncio
import sys
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Final, final

from pydantic import JsonValue, TypeAdapter, ValidationError

from semiont.errors import SemiontError

__all__ = ["Arguments", "Misuse", "Operation", "count", "failure", "object_of", "optional_text", "say", "serve", "text", "texts"]

type Arguments = Mapping[str, JsonValue]


class Misuse(Exception):
    """The suite sent something this driver cannot act on: the suite's mistake, never the SDK's."""


@final
@dataclass(frozen=True, slots=True)
class Operation:
    """One operation a driver performs."""

    perform: Callable[[int, Arguments], Awaitable[JsonValue]]
    """Given the operation's id and its arguments, what it answers with."""
    in_turn: bool = False
    """It settles before the next operation is read: what follows it finds it done."""
    abandonable: bool = False
    """Its caller can abandon it, and it then settles as `abandoned`."""


_LINE: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


def say(line: Mapping[str, JsonValue]) -> None:
    """Write one line of the protocol."""
    sys.stdout.write(_LINE.dump_json(dict(line)).decode() + "\n")
    sys.stdout.flush()


def text(args: Arguments, name: str) -> str:
    """The argument `name`, which is text."""
    value = args.get(name)
    if not isinstance(value, str):
        raise Misuse(f"{name} must be a string")
    return value


def optional_text(args: Arguments, name: str) -> str | None:
    """The argument `name`, which is text when it is given."""
    return None if args.get(name) is None else text(args, name)


def count(args: Arguments, name: str) -> int:
    """The argument `name`, which is a whole number."""
    value = args.get(name)
    if isinstance(value, bool) or not isinstance(value, int):
        raise Misuse(f"{name} must be a number")
    return value


def object_of(args: Arguments, name: str) -> Arguments:
    """The argument `name`, which is an object."""
    value = args.get(name)
    if not isinstance(value, dict):
        raise Misuse(f"{name} must be an object")
    return value


def texts(args: Arguments, name: str) -> list[str]:
    """The argument `name`, which is a list of text."""
    value = args.get(name)
    if not isinstance(value, list):
        raise Misuse(f"{name} must be a list of strings")
    found: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise Misuse(f"{name} must be a list of strings")
        found.append(item)
    return found


def failure(error: BaseException) -> dict[str, JsonValue]:
    """A failure as the protocol carries it: the SDK's code, and the status when a server stated one."""
    detail = f"{type(error).__name__}: {error}"
    if not isinstance(error, SemiontError):
        return {"detail": detail}
    stated: dict[str, JsonValue] = {"code": error.code}
    if error.status is not None:
        stated["status"] = error.status
    stated["detail"] = detail
    return stated


@final
class _Serving:
    """The operations a driver is running, each answered once."""

    def __init__(self, operations: Mapping[str, Operation]) -> None:
        self._operations = operations
        self._unsettled: dict[int, asyncio.Task[None]] = {}
        self._abandoned: set[int] = set()

    async def _settle(self, asked: int, operation: Operation, args: Arguments) -> None:
        try:
            value = await operation.perform(asked, args)
        except Misuse as misuse:
            say({"id": asked, "misuse": str(misuse)})
        except asyncio.CancelledError:
            if asked not in self._abandoned:
                raise
            say({"id": asked, "abandoned": True})
        except Exception as error:
            # Whatever the SDK raised is what the suite judges: under its code when it has one.
            say({"id": asked, "error": failure(error)})
        else:
            say({"id": asked, "ok": value})

    def _abandon(self, asked: int, args: Arguments) -> None:
        try:
            abandoned = count(args, "request")
            running = self._unsettled.get(abandoned)
            if running is None or running.done():
                raise Misuse("no such request is unsettled")
        except Misuse as misuse:
            say({"id": asked, "misuse": str(misuse)})
            return
        self._abandoned.add(abandoned)
        running.cancel()
        say({"id": asked, "ok": None})

    async def line(self, running: asyncio.TaskGroup, line: bytes) -> None:
        """Act on one line of the suite's."""
        try:
            said = _LINE.validate_json(line)
        except ValidationError as error:
            print(f"a line that is not an operation: {error}", file=sys.stderr)
            return
        asked, op = said.get("id"), said.get("op")
        if isinstance(asked, bool) or not isinstance(asked, int) or not isinstance(op, str):
            print(f"a line that is not an operation: {line!r}", file=sys.stderr)
            return
        args = {name: value for name, value in said.items() if name not in ("id", "op")}
        if op == "abandon" and any(operation.abandonable for operation in self._operations.values()):
            self._abandon(asked, args)
            return
        operation = self._operations.get(op)
        if operation is None:
            say({"id": asked, "unsupported": True})
        elif operation.in_turn:
            await self._settle(asked, operation, args)
        else:
            self._unsettled[asked] = running.create_task(self._settle(asked, operation, args))

    def end(self) -> None:
        """The suite has no more to ask: what is still running is left, and reports nothing."""
        for running in self._unsettled.values():
            running.cancel()


async def serve(operations: Mapping[str, Operation], dispose: Callable[[], Awaitable[None]]) -> int:
    """Answer the suite until its stdin ends, then `dispose`. Returns the process's exit status."""
    serving = _Serving(operations)
    say({"ready": True})
    async with asyncio.TaskGroup() as running:
        # Read on a thread: a pipe, a file and a terminal are all read alike.
        while line := await asyncio.to_thread(sys.stdin.buffer.readline):
            await serving.line(running, line)
        serving.end()
    await dispose()
    return 0
