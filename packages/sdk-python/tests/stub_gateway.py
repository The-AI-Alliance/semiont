"""A gateway's two bus routes, scripted: enough of HTTP/1.1 to hold a stream open and answer an emit.

For what the conformance corpus cannot script: it stands where a gateway
would, on this machine, and does only what a test tells it to.
"""

import asyncio
from collections.abc import Callable
from types import TracebackType
from typing import Self, final

from pydantic import JsonValue, TypeAdapter
from spec import JsonObject

from semiont.watched import Variable, reached

_OBJECT = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


@final
class StubGateway:
    """Held with `async with`. `origin` is where a transport is pointed."""

    def __init__(self) -> None:
        self.subscriptions: list[JsonObject] = []
        """The body of each subscribe request, in the order they came."""
        self.emits: list[JsonObject] = []
        """The body of each emit, in the order they came."""
        self.tokens: list[str] = []
        """The `Authorization` of each request, in the order they came."""
        self.on_emit: Callable[[JsonObject], None] | None = None
        """What the gateway does when it has accepted an emit."""
        self.emit_answers: list[tuple[int, dict[str, str], bytes]] = []
        """Answers for the next emits, in place of `202 {"subscribers": 1}`: a status, headers, a body."""
        self.accepting = True
        """Whether a subscribe is answered with a stream. Otherwise it is answered 503."""
        self._streams: list[asyncio.StreamWriter] = []
        self._streaming: Variable[int] = Variable(0)
        self._emitted: Variable[int] = Variable(0)
        self._server: asyncio.Server | None = None
        self.origin = ""

    async def __aenter__(self) -> Self:
        self._server = await asyncio.start_server(self._connection, "127.0.0.1", 0)
        self.origin = f"http://127.0.0.1:{self._server.sockets[0].getsockname()[1]}"
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self.drop()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def streams(self, count: int) -> None:
        """Wait until `count` subscribe requests have been answered with a stream."""
        await reached(self._streaming, lambda streaming: streaming >= count)

    async def emitted(self, count: int) -> None:
        """Wait until `count` emits have arrived."""
        await reached(self._emitted, lambda emitted: emitted >= count)

    def send(self, event_id: str | None, frame: JsonObject) -> None:
        """Write one frame to every stream that is open."""
        self.write(("" if event_id is None else f"id: {event_id}\n") + f"event: bus-event\ndata: {_OBJECT.dump_json(frame).decode()}\n\n")

    def write(self, text: str) -> None:
        """Write `text`, as it is, to every stream that is open."""
        data = text.encode()
        for stream in self._streams:
            stream.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")

    def drop(self) -> None:
        """End every stream."""
        streams, self._streams = self._streams, []
        for stream in streams:
            stream.close()

    async def _connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while request_line := await reader.readline():
                path = request_line.decode().split(" ")[1]
                headers: dict[str, str] = {}
                while (line := await reader.readline()).strip():
                    name, _, value = line.decode().partition(":")
                    headers[name.strip().lower()] = value.strip()
                body = _OBJECT.validate_json(await reader.readexactly(int(headers["content-length"])))
                self.tokens.append(headers["authorization"])
                if path == "/bus/subscribe":
                    self.subscriptions.append(body)
                    if not self.accepting:
                        writer.write(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                        await writer.drain()
                        continue
                    writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
                    await writer.drain()
                    self._streams.append(writer)
                    self._streaming.set(self._streaming.value + 1)
                    # The stream is the response: it lasts until one side closes the connection.
                    await reader.read()
                    return
                self.emits.append(body)
                self._emitted.set(len(self.emits))
                status, stated, answer = self.emit_answers.pop(0) if self.emit_answers else (202, {}, b'{"subscribers":1}')
                extra = "".join(f"{name}: {value}\r\n" for name, value in stated.items())
                writer.write(
                    f"HTTP/1.1 {status} Answered\r\nContent-Type: application/json\r\nContent-Length: {len(answer)}\r\n{extra}\r\n".encode()
                )
                writer.write(answer)
                await writer.drain()
                if status < 300 and self.on_emit is not None:
                    self.on_emit(body)
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
