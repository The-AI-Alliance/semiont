"""A resource's bytes, read from an Archivist a test plays over real HTTP.

The Archivist's content route is `specs/src/archivist/openapi.json`'s: the
bytes as they are stored, under the content type the record stores, or a 404
that says which half of the lookup failed. Here is what the Smelter's reader
asks, what it hands over of each answer, and that whatever keeps the bytes
from being read is a `ContentUnread` that says what it was.
"""

import asyncio
import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from http import HTTPStatus
from types import TracebackType
from typing import Final, Self, final, override

import pytest
from aio import run
from semiont.errors import SemiontError, SignInError
from semiont.identifiers import ResourceId

from semiont_smelter.archivist import ArchivistContent, Authorizes
from semiont_smelter.content import Content, ContentUnread

RESOURCE: Final = ResourceId("res-1")
TOKEN: Final = "Bearer the-smelters-own-token"


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Said:
    """What the played Archivist answers a request with."""

    status: int = 200
    headers: Mapping[str, str] = field(default_factory=dict[str, str])
    body: bytes = b""
    hang_up: bool = False
    """Close the connection without a word."""


@final
@dataclass(frozen=True, slots=True)
class Asked:
    """One request, as it arrived."""

    method: str
    path: str
    headers: Mapping[str, str]


@final
class PlayedArchivist:
    """Enough of HTTP/1.1 to answer one request for each connection, as a test said to, and to keep what it was asked."""

    def __init__(self, says: Said) -> None:
        self.says: Final = says
        self.asked: Final[list[Asked]] = []
        self.port = 0
        self._server: asyncio.Server | None = None

    async def __aenter__(self) -> Self:
        self._server = await asyncio.start_server(self._connection, "127.0.0.1", 0)
        name: tuple[object, ...] = self._server.sockets[0].getsockname()
        port = name[1]
        assert isinstance(port, int)
        self.port = port
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        assert self._server is not None
        self._server.close()
        await self._server.wait_closed()

    async def _connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        head = (await reader.readuntil(b"\r\n\r\n")).decode("ascii")
        request, *stated = head.split("\r\n")
        method, path, _ = request.split(" ")
        headers = {name.lower(): value for name, value in (line.split(": ", 1) for line in stated if line)}
        self.asked.append(Asked(method, path, headers))
        if not self.says.hang_up:
            lines = [
                f"HTTP/1.1 {self.says.status} {HTTPStatus(self.says.status).phrase}",
                *(f"{name}: {value}" for name, value in self.says.headers.items()),
                f"Content-Length: {len(self.says.body)}",
                "Connection: close",
                "",
                "",
            ]
            writer.write("\r\n".join(lines).encode("ascii") + self.says.body)
            await writer.drain()
        writer.close()
        await writer.wait_closed()


@final
class Account(Authorizes):
    """An account that signs in as a test said: with `TOKEN`, or not at all."""

    def __init__(self, *, refused: SemiontError | None = None) -> None:
        self._refused: Final = refused
        self.asked = 0

    @override
    async def authorization(self) -> str:
        self.asked += 1
        if self._refused is not None:
            raise self._refused
        return TOKEN


async def read_of(says: Said, *, account: Account | None = None) -> tuple[Content, PlayedArchivist]:
    """What the reader hands over of one answer, and the Archivist that gave it."""
    asking = Account() if account is None else account
    async with (
        PlayedArchivist(says) as archivist,
        ArchivistContent(host="127.0.0.1", port=archivist.port, account=asking) as content,
    ):
        return await content.read(RESOURCE), archivist


async def unread(says: Said) -> str:
    """What the reader says of an answer that gives it no bytes."""
    with pytest.raises(ContentUnread) as failure:
        await read_of(says)
    return str(failure.value)


def not_found(code: str) -> Said:
    """An Archivist's 404 that says which half of the lookup failed."""
    body = json.dumps({"error": "Not found", "code": code}).encode("utf-8")
    return Said(status=404, headers={"Content-Type": "application/json"}, body=body)


def test_the_bytes_are_asked_for_by_the_resource_s_id_as_the_account_it_was_handed() -> None:
    async def scenario() -> None:
        account = Account()
        _, archivist = await read_of(Said(headers={"Content-Type": "text/plain"}, body=b"Keokuk"), account=account)
        (asked,) = archivist.asked
        assert (asked.method, asked.path) == ("GET", "/resources/res-1/content")
        assert asked.headers["authorization"] == TOKEN
        # The account is asked for its token at each read: it is the account's to keep and to renew.
        assert account.asked == 1

    run(scenario())


def test_the_bytes_are_handed_over_as_they_were_served_with_the_content_type_whole() -> None:
    async def scenario() -> None:
        # Bytes that are no text in any charset, and a content type that states one: neither is read here.
        served = bytes(range(256)) * 3
        content, _ = await read_of(Said(headers={"Content-Type": "text/plain; charset=iso-8859-1"}, body=served))
        assert content == Content(served, "text/plain; charset=iso-8859-1")

    run(scenario())


def test_a_resource_of_no_bytes_is_read_as_no_bytes() -> None:
    async def scenario() -> None:
        content, _ = await read_of(Said(headers={"Content-Type": "application/pdf"}))
        assert content == Content(b"", "application/pdf")

    run(scenario())


@pytest.mark.parametrize(
    ("code", "which"),
    [("resource", "the record holds no such resource"), ("representation", "the record holds the resource and not its bytes")],
)
def test_a_404_is_unread_and_says_which_half_of_the_lookup_failed(code: str, which: str) -> None:
    async def scenario() -> None:
        assert await unread(not_found(code)) == f"the Archivist has no bytes for res-1: {which}"

    run(scenario())


def test_a_404_that_does_not_say_which_half_failed_is_unread_and_says_so() -> None:
    async def scenario() -> None:
        untold = "the Archivist answered 404, and did not say whether the resource or its bytes are missing"
        for said in (Said(status=404), not_found("nothing-the-schema-names"), Said(status=404, body=b"<html>")):
            assert await unread(said) == f"the Archivist has no bytes for res-1: {untold}"

    run(scenario())


@pytest.mark.parametrize("status", [401, 500, 503])
def test_any_other_failing_status_is_unread_and_states_the_status(status: int) -> None:
    async def scenario() -> None:
        failed = Said(status=status, headers={"Content-Type": "application/json"}, body=b'{"error": "it could not be read"}')
        assert await unread(failed) == f"the Archivist answered {status} for the bytes of res-1"

    run(scenario())


def test_bytes_served_under_no_content_type_are_unread() -> None:
    async def scenario() -> None:
        # What the bytes are is the record's to say. Nothing is supposed of bytes that come with no type.
        assert await unread(Said(body=b"Keokuk")) == "the Archivist stated no content type for the bytes of res-1"

    run(scenario())


def test_an_archivist_that_hangs_up_or_is_not_there_is_unread() -> None:
    async def scenario() -> None:
        assert (await unread(Said(hang_up=True))).startswith("the Archivist did not answer for the bytes of res-1: ")
        # Nothing listens at this port.
        async with ArchivistContent(host="127.0.0.1", port=1, account=Account()) as content:
            with pytest.raises(ContentUnread, match="the Archivist did not answer for the bytes of res-1: "):
                await content.read(RESOURCE)

    run(scenario())


def test_an_account_that_cannot_sign_in_is_unread_and_the_archivist_is_asked_nothing() -> None:
    async def scenario() -> None:
        refused = Account(refused=SignInError("exchange", "Client-credentials grant for semiont-smelter failed (HTTP 401)"))
        async with (
            PlayedArchivist(Said()) as archivist,
            ArchivistContent(host="127.0.0.1", port=archivist.port, account=refused) as content,
        ):
            with pytest.raises(ContentUnread, match="the smelter could not sign in") as failure:
                await content.read(RESOURCE)
            assert "Client-credentials grant for semiont-smelter failed (HTTP 401)" in str(failure.value)
            assert archivist.asked == []

    run(scenario())


def test_a_reader_that_is_not_held_open_reads_nothing() -> None:
    async def scenario() -> None:
        content = ArchivistContent(host="127.0.0.1", port=1, account=Account())
        with pytest.raises(RuntimeError, match="hold it with `async with`"):
            await content.read(RESOURCE)

    run(scenario())
