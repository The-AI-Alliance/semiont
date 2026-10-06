"""A gateway, scripted: enough of HTTP/1.1 to hold a stream open and answer what a client asks of one.

For what the conformance corpus cannot script: it stands where a gateway
would, on this machine, and does only what a test tells it to.
"""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from types import TracebackType
from typing import Final, Self, final

from pydantic import JsonValue, TypeAdapter
from spec import JsonObject

from semiont.watched import Variable, reached

_OBJECT = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])
_JSON = TypeAdapter[JsonValue](JsonValue)


@final
@dataclass(frozen=True, slots=True)
class Asked:
    """One request, as it arrived."""

    method: str
    path: str
    headers: dict[str, str]
    body: bytes

    def json(self) -> JsonObject:
        """Its body, which is a JSON object."""
        return _OBJECT.validate_json(self.body)

    def form(self) -> dict[str, tuple[bytes, dict[str, str]]]:
        """Its body, which is `multipart/form-data`: each part's bytes and the headers it came under, by its name."""
        boundary = self.headers["content-type"].split("boundary=")[1].encode()
        parts: dict[str, tuple[bytes, dict[str, str]]] = {}
        for part in self.body.split(b"--" + boundary)[1:-1]:
            head, _, data = part.removeprefix(b"\r\n").partition(b"\r\n\r\n")
            headers = {
                name.strip().lower(): value.strip() for name, _, value in (line.partition(":") for line in head.decode().split("\r\n"))
            }
            name = headers["content-disposition"].split('name="')[1].split('"')[0]
            parts[name] = (data.removesuffix(b"\r\n"), headers)
        return parts


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Answer:
    """What the gateway says to one request, in place of what it would have said."""

    status: int = 200
    headers: dict[str, str] = field(default_factory=dict[str, str])
    body: bytes = b"{}"
    hold: bool = False
    """Say nothing: the request is kept waiting until the gateway is left."""
    hang_up: bool = False
    """Close the connection without a word."""
    promise: int | None = None
    """State this length for the body, send the body there is, and close: the bytes stop coming."""


NOT_FOUND: Final = Answer(status=404, body=b'{"error":"The gateway has no such thing"}')


@final
class StubGateway:
    """Held with `async with`. `origin` is where a transport is pointed."""

    def __init__(self) -> None:
        self.asked: list[Asked] = []
        """Every request, in the order they came."""
        self.scripted: dict[tuple[str, str], list[Answer]] = {}
        """Answers for the next requests of a method and path, in place of the gateway's own."""
        self.on_emit: Callable[[JsonObject], None] | None = None
        """What the gateway does when it has accepted an emit."""
        self.stored: dict[str, tuple[str, bytes]] = {}
        """Each resource's media type and bytes."""
        self.described: dict[str, JsonObject] = {}
        """Each resource's description."""
        self.answers: dict[str, JsonObject] = {}
        """What each of the gateway's own operations answers, by its path."""
        self.closed_by_client = asyncio.Event()
        """Set when a connection the gateway was holding a request on is closed from the other end."""
        self._streams: list[asyncio.StreamWriter] = []
        self._connections: set[asyncio.StreamWriter] = set()
        self._streaming: Variable[int] = Variable(0)
        self._arrived: Variable[int] = Variable(0)
        self._leaving = asyncio.Event()
        self._server: asyncio.Server | None = None
        self.origin = ""

    async def __aenter__(self) -> Self:
        self._server = await asyncio.start_server(self._connection, "127.0.0.1", 0)
        self.origin = f"http://127.0.0.1:{self._server.sockets[0].getsockname()[1]}"
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        self._leaving.set()
        self.drop()
        if self._server is not None:
            self._server.close()
            # Whatever a client still holds open is closed from this end: leaving waits for nobody.
            for connection in list(self._connections):
                connection.close()
            await self._server.wait_closed()

    def of(self, method: str, path: str) -> list[Asked]:
        """The requests of one method and path."""
        return [asked for asked in self.asked if (asked.method, asked.path) == (method, path)]

    @property
    def subscriptions(self) -> list[JsonObject]:
        """The body of each subscribe request."""
        return [asked.json() for asked in self.of("POST", "/bus/subscribe")]

    @property
    def emits(self) -> list[JsonObject]:
        """The body of each emit."""
        return [asked.json() for asked in self.of("POST", "/bus/emit")]

    async def streams(self, count: int) -> None:
        """Wait until `count` subscribe requests have been answered with a stream."""
        await reached(self._streaming, lambda streaming: streaming >= count)

    async def arrived(self, method: str, path: str, count: int = 1) -> None:
        """Wait until `count` requests of a method and path have arrived."""
        await reached(self._arrived, lambda _: len(self.of(method, path)) >= count)

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

    def _own(self, asked: Asked) -> Answer:
        """What the gateway itself says to a request nothing was scripted for."""
        method, path = asked.method, asked.path
        if (method, path) == ("POST", "/bus/emit"):
            return Answer(status=202, body=b'{"subscribers":1}')
        if (method, path) == ("POST", "/resources"):
            return Answer(status=202, body=_JSON.dump_json({"resourceId": f"res-uploaded-{len(self.of(method, path))}"}))
        if method == "GET" and path.startswith("/resources/"):
            resource, _, what = path.removeprefix("/resources/").partition("/")
            if what == "jsonld" and resource in self.described:
                return Answer(body=_OBJECT.dump_json(self.described[resource]))
            if what == "" and resource in self.stored:
                media_type, data = self.stored[resource]
                return Answer(headers={"Content-Type": media_type}, body=data)
            return NOT_FOUND
        if path in self.answers:
            return Answer(body=_OBJECT.dump_json(self.answers[path]))
        return NOT_FOUND

    async def _connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._connections.add(writer)
        try:
            while request_line := await reader.readline():
                method, path = request_line.decode().split(" ")[:2]
                headers: dict[str, str] = {}
                while (line := await reader.readline()).strip():
                    name, _, value = line.decode().partition(":")
                    headers[name.strip().lower()] = value.strip()
                asked = Asked(method, path, headers, await reader.readexactly(int(headers.get("content-length", "0"))))
                self.asked.append(asked)
                self._arrived.set(len(self.asked))
                scripted = self.scripted.get((method, path))
                if (method, path) == ("POST", "/bus/subscribe") and not scripted:
                    writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
                    await writer.drain()
                    self._streams.append(writer)
                    self._streaming.set(self._streaming.value + 1)
                    # The stream is the response: it lasts until one side closes the connection.
                    await reader.read()
                    return
                answer = scripted.pop(0) if scripted else self._own(asked)
                if answer.hang_up:
                    return
                if answer.hold:
                    # Nothing is said. It ends when the client closes the connection, or the gateway is left.
                    closed = asyncio.ensure_future(reader.read())
                    leaving = asyncio.ensure_future(self._leaving.wait())
                    await asyncio.wait({closed, leaving}, return_when=asyncio.FIRST_COMPLETED)
                    if closed.done():
                        self.closed_by_client.set()
                    for waiting in (closed, leaving):
                        waiting.cancel()
                    await asyncio.gather(closed, leaving, return_exceptions=True)
                    return
                stated = {"Content-Type": "application/json", **answer.headers}
                length = len(answer.body) if answer.promise is None else answer.promise
                head = f"HTTP/1.1 {answer.status} Answered\r\nContent-Length: {length}\r\n" + "".join(
                    f"{k}: {v}\r\n" for k, v in stated.items()
                )
                writer.write(head.encode() + b"\r\n" + answer.body)
                await writer.drain()
                if answer.promise is not None:
                    return
                if (method, path) == ("POST", "/bus/emit") and answer.status < 300 and self.on_emit is not None:
                    self.on_emit(asked.json())
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            self._connections.discard(writer)
            writer.close()
