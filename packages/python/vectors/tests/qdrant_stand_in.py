"""A Qdrant, played: enough of HTTP/1.1 to answer each request the Qdrant store and the Qdrant reader make, and to keep what it carried.

Every request is answered alike, with a success of every shape the store
reads one in: a collection's making and its deleting with `true`, and every
other request with one object that has a member for each call's answer,
each read by its own call and passed over by the others. So each member of
a store and of a reader runs to its end, asking all it asks. Nothing is
kept but the requests: what a real Qdrant does with them is held by
`qdrant_live.py`.

A request that does not carry `TOKEN` in its `api-key` header is answered
401, as a Qdrant run with an API key answers one that carries neither the
key nor a token.
"""

import asyncio
import re
from dataclasses import dataclass
from types import TracebackType
from typing import Final, Self, final

from pydantic import JsonValue, TypeAdapter

TOKEN: Final = "a-token"
"""The token the stand-in takes."""

_JSON: Final = TypeAdapter[JsonValue](JsonValue)

# A collection's own path, which a collection is made at with PUT and deleted at with DELETE.
_COLLECTION: Final = re.compile(r"^/collections/[^/]+$")

_EVERY_ANSWER: Final[JsonValue] = {
    "status": "completed",
    "operation_id": 1,
    "collections": [],
    "config": {},
    "points": [],
    "groups": [],
    "count": 0,
    "next_page_offset": None,
}
"""What every other request is answered: a write's status, the collections listed, what a collection is, a page, a count, groups."""


@final
@dataclass(frozen=True, slots=True)
class Asked:
    """One request, as it arrived: its method, its path without the query, and its headers, by their names in lower case."""

    method: str
    path: str
    headers: dict[str, str]


@final
class PlayedQdrant:
    """A stand-in Qdrant, listening on a port of this machine while it is held with `async with`."""

    def __init__(self) -> None:
        self.port = 0
        self.asked: list[Asked] = []
        """Every request, in the order they came."""
        self._server: asyncio.Server | None = None
        self._connections: set[asyncio.StreamWriter] = set()

    async def __aenter__(self) -> Self:
        self._server = await asyncio.start_server(self._connection, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        if self._server is not None:
            self._server.close()
            # Whatever a client still holds open is closed from this end: leaving waits for nobody.
            for connection in list(self._connections):
                connection.close()
            await self._server.wait_closed()

    @staticmethod
    def _answer(asked: Asked) -> tuple[str, bytes]:
        """The status line and the body `asked` is answered with."""
        if asked.headers.get("api-key") != TOKEN:
            # As a Qdrant says it: in plain text, and in no envelope.
            return "401 Unauthorized", b"Must provide an API key or an Authorization bearer token"
        result: JsonValue = True if asked.method in ("PUT", "DELETE") and _COLLECTION.match(asked.path) else _EVERY_ANSWER
        return "200 OK", _JSON.dump_json({"result": result, "status": "ok", "time": 0.0})

    async def _connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._connections.add(writer)
        try:
            while request_line := await reader.readline():
                method, target = request_line.decode().split(" ")[:2]
                headers: dict[str, str] = {}
                while (line := await reader.readline()).strip():
                    name, _, value = line.decode().partition(":")
                    headers[name.strip().lower()] = value.strip()
                await reader.readexactly(int(headers.get("content-length", "0")))
                asked = Asked(method, target.partition("?")[0], headers)
                self.asked.append(asked)
                status, body = self._answer(asked)
                writer.write(f"HTTP/1.1 {status}\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
                await writer.drain()
        except ConnectionError:
            pass
        finally:
            self._connections.discard(writer)
            writer.close()
