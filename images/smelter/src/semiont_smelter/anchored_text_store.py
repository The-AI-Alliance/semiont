"""The anchored-text store, which the Archivist keeps: what was derived from some bytes, kept under the checksum of those bytes.

Deriving the text of a PDF costs seconds for each page that is read from
pixels, and the same text is asked for again and again. So what was derived
is kept: a text with where each of its words is and how it was derived, or
the decline that came of trying. Everything kept is derived from the bytes,
so an entry that is not taken costs deriving it again, and nothing else.

The Archivist keeps the store, and no other process mounts it
(`docs/protocol/ARCHIVIST.md` § The anchored-text store). The Smelter reaches
it on the Archivist's own surface (`specs/src/archivist/openapi.json`), as
its service account, at the address its document names:

- an entry is written for a resource's bytes by
  `PUT /resources/{id}/anchored-text`, with the checksum of the bytes it was
  derived from: the key it is kept under;
- it is read back by `GET /resources/{id}/anchored-text/stored`, with the
  checksum of the bytes that were read, and is answered at once;
- the keys kept under the stamp are listed by `GET /anchored-text/entries`;
- the stamp is stated by `PUT /anchored-text/stamp`, once, before the first
  write or listing.

An entry holds the protocol's `AnchoredTextEntry`, sent as compact JSON with
`v` and `stamp` first. It is its outcome's members, by the names the wire
gives them, without `kind`, which the entry's own shape says, and with the
items packed as lines. Each entry is held to the SDK's model of it before it
is sent, and is read back through that model.

An entry's bytes are those of the document the model was shown, and not
those of the model. The model holds a word as four fractions, and written
from it a word's offsets would be `0.0` and `5.0`. The Archivist hands a
word's offsets on as they are stored, to readers that take only a whole
number for one.

An entry is taken only under the stamp it was written with, which says which
reader of PDFs and which engine derived it (`semiont_smelter.stamp`). The
Archivist cannot work a stamp out, so the store states its own. Nothing here
deletes an entry.
"""

import asyncio
import json
import re
from collections.abc import Sequence
from types import TracebackType
from typing import Final, Protocol, Self, final, override

import httpx
from pydantic import JsonValue, TypeAdapter, ValidationError
from semiont.errors import SemiontError
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.types import (
    AnchoredTextDeclinedEntry,
    AnchoredTextEntries,
    AnchoredTextEntry,
    AnchoredTextExtractedEntry,
    ExtractedText,
    ExtractionOutcome,
    PdfTextItem,
)
from semiont_service.archivist import Authorizes

from semiont_smelter.log import LOG, words_of

__all__ = ["AnchoredTextStore", "AnchoredTexts", "StoreFailed"]

_VERSION: Final = 3
"""The entry format, which says what an entry's numbers mean. The entry's model takes no other."""

_TIMEOUT: Final = httpx.Timeout(60.0, connect=10.0)
"""How long the Archivist is waited for: ten seconds to connect, and a minute for each part of an answer.

No bound is put on a whole answer: a large entry takes as long as it takes,
as long as it keeps coming.
"""

_STAMP: Final = re.compile(r"\S+")
"""A stamp the Archivist keeps: text with no white space, since it keeps it as a file of one line."""

_OK: Final = 200
_DONE: Final = 204
_NOT_FOUND: Final = 404
_STALE: Final = 409

_UNREAD: Final = "An anchored-text entry was not read back, and is derived again"
"""What is said of a read the Archivist did not answer."""

_ENTRY: Final = TypeAdapter[AnchoredTextEntry](AnchoredTextEntry)
_OUTCOME: Final = TypeAdapter[ExtractionOutcome](ExtractionOutcome)


@final
class StoreFailed(Exception):
    """The Archivist did not do what the store asked of it: it was not reached, the account could not sign in, or it refused."""


class AnchoredTexts(Protocol):
    """What the Smelter keeps of what it derived, and asks back: the store kept by the Archivist is one."""

    async def read(self, resource_id: ResourceId, key: str) -> ExtractionOutcome | None:
        """The outcome kept under `key`, the checksum of the resource's bytes as they were read, or `None` for any miss. Never raises."""
        ...

    async def write(self, resource_id: ResourceId, key: str, outcome: ExtractionOutcome) -> None:
        """Keep an outcome under `key`, the checksum of the resource's bytes it was derived from.

        Raises `ValueError` for an outcome that makes no entry
        (`ValidationError` is one), and `StoreFailed` where it was not kept.
        """
        ...

    # The last member: below this one, `list` in a signature would name this method.
    async def list(self) -> list[str]:
        """Every key `read` would answer an outcome for, in order. Raises `StoreFailed` where they could not be listed."""
        ...


def _compact(document: dict[str, JsonValue]) -> str:
    """A document as compact JSON, its members in the order they were put in.

    Raises `ValueError` for a number that is not finite: JSON has none.
    """
    return json.dumps(document, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _lines(items: Sequence[PdfTextItem]) -> list[JsonValue]:
    """The items packed as lines: each run of items that share a page, a y and a height is one line, its words in the items' order.

    Only items that follow one another are put together, and none is moved.
    So the items are read back as they were given, in whatever order they
    came: how many lines they make depends on their order, and nothing else
    does. A word keeps its own x and width.
    """
    lines: list[JsonValue] = []
    shared: tuple[float, float, float] | None = None
    words: list[JsonValue] = []
    for item in items:
        place = (item.page, item.y, item.height)
        if place != shared:
            shared = place
            words = []
            # A page is a whole number in an entry. One that is not is left as it is, for the entry's model to refuse.
            page: JsonValue = int(item.page) if item.page.is_integer() else item.page
            line: dict[str, JsonValue] = {"p": page, "y": item.y, "h": item.height, "words": words}
            lines.append(line)
        word: list[JsonValue] = [item.x, item.width, item.start, item.end]
        words.append(word)
    return lines


def _entry_of(outcome: ExtractionOutcome, stamp: str) -> dict[str, JsonValue]:
    """The entry that records an outcome under a stamp, `v` and `stamp` first.

    Whatever an outcome says of itself is carried under the wire's name for
    it, with no member named here. Raises `ValidationError` for what the
    entry's model does not take: an outcome with a member an entry has
    none for, or an item on a page that is no whole number.
    """
    wire = written(outcome)
    del wire["kind"]
    entry: dict[str, JsonValue] = {"v": _VERSION, "stamp": stamp}
    if isinstance(outcome, ExtractedText):
        del wire["items"]
        entry["text"] = wire.pop("text")
        entry["lines"] = _lines(outcome.items)
        entry.update(wire)
        AnchoredTextExtractedEntry.model_validate(entry)
    else:
        entry.update(wire)
        AnchoredTextDeclinedEntry.model_validate(entry)
    return entry


def _outcome_of(entry: AnchoredTextEntry) -> ExtractionOutcome:
    """The outcome an entry records: its members without `v` and `stamp`, the `kind` its shape says, and its lines as items.

    Raises `ValidationError` for an entry whose words are no items: an
    offset that is no whole number, or is below 0.
    """
    wire = written(entry)
    del wire["v"], wire["stamp"]
    if isinstance(entry, AnchoredTextDeclinedEntry):
        return _OUTCOME.validate_python({"kind": "declined", **wire})
    del wire["lines"]
    items: list[JsonValue] = []
    for line in entry.lines:
        for x, width, start, end in line.words:
            item: dict[str, JsonValue] = {
                "start": start,
                "end": end,
                "page": line.p,
                "x": x,
                "y": line.y,
                "width": width,
                "height": line.h,
            }
            items.append(item)
    return _OUTCOME.validate_python({"kind": "extracted", "items": items, **wire})


def _said(answer: httpx.Response) -> str:
    """What an answer that is not the one asked for says: its status, and its body's `error` where it states one."""
    try:
        said: JsonValue = json.loads(answer.content)
    except ValueError:
        said = None
    error = said.get("error") if isinstance(said, dict) else None
    return f"{answer.status_code}: {error}" if isinstance(error, str) else str(answer.status_code)


@final
class AnchoredTextStore(AnchoredTexts):
    """The store the Archivist at `host` and `port` keeps, under one stamp, asked as the account `account` for the service `service`.

    Held with `async with`: its connections are closed on the way out.
    Raises `ValueError` for a stamp that is empty or has white space in it:
    the Archivist keeps no such one.
    """

    def __init__(self, service: str, *, host: str, port: int, account: Authorizes, stamp: str) -> None:
        if _STAMP.fullmatch(stamp) is None:
            raise ValueError(f"an anchored-text store's stamp is text with no white space, and {stamp!r} is not")
        self._service: Final = service
        self._origin: Final = f"http://{host}:{port}"
        self._account: Final = account
        self._stamp: Final = stamp
        self._client: httpx.AsyncClient | None = None
        self._stated = False
        self._stating: Final = asyncio.Lock()

    async def __aenter__(self) -> Self:
        self._client = httpx.AsyncClient(base_url=self._origin, timeout=_TIMEOUT, trust_env=False)
        return self

    async def __aexit__(self, kind: type[BaseException] | None, error: BaseException | None, trace: TracebackType | None) -> None:
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    async def _asked(self, method: str, path: str, *, query: dict[str, str] | None = None, body: bytes | None = None) -> httpx.Response:
        """One request of the Archivist, as the account.

        Raises `StoreFailed` where the account could not sign in or the Archivist did not answer.
        """
        if self._client is None:
            raise RuntimeError("the anchored-text store is not open: hold it with `async with`")
        try:
            authorization = await self._account.authorization()
        except SemiontError as failure:
            raise StoreFailed(f"{method} {path} was not asked: the {self._service} could not sign in ({failure})") from failure
        headers = {"Authorization": authorization}
        if body is not None:
            headers["Content-Type"] = "application/json"
        try:
            return await self._client.request(method, path, params=query, content=body, headers=headers)
        except httpx.HTTPError as failure:
            raise StoreFailed(f"the Archivist did not answer {method} {path}: {type(failure).__name__}: {failure}") from failure

    async def _state_stamp(self) -> None:
        """State this store's stamp to the Archivist, the first time it is needed. Raises `StoreFailed` where it was not stated."""
        async with self._stating:
            if self._stated:
                return
            answer = await self._asked("PUT", "/anchored-text/stamp", body=_compact({"stamp": self._stamp}).encode("utf-8"))
            if answer.status_code != _DONE:
                raise StoreFailed(f"the Archivist did not take the stamp {self._stamp}: {_said(answer)}")
            self._stated = True

    @override
    async def read(self, resource_id: ResourceId, key: str) -> ExtractionOutcome | None:
        """The outcome kept under `key`, or `None` for any miss. Never raises.

        A miss is bytes with no entry, bytes the resource no longer has, an
        entry of another version or under another stamp, an answer that is
        no entry, and an Archivist that did not answer. Each costs deriving
        the text again; one the Archivist did not answer is said.
        """
        try:
            answer = await self._asked("GET", f"/resources/{resource_id}/anchored-text/stored", query={"contentChecksum": key})
        except StoreFailed as failure:
            LOG.warning(_UNREAD, extra={"resourceId": resource_id, "contentChecksum": key, "error": words_of(failure)})
            return None
        if answer.status_code in (_NOT_FOUND, _STALE):
            return None
        if answer.status_code != _OK:
            LOG.warning(_UNREAD, extra={"resourceId": resource_id, "contentChecksum": key, "error": _said(answer)})
            return None
        try:
            entry = _ENTRY.validate_json(answer.content)
            return _outcome_of(entry) if entry.stamp == self._stamp else None
        except ValueError:
            # No JSON, no entry, or words that are no items: each is a miss. What a model refuses is a `ValueError`.
            return None

    @override
    async def write(self, resource_id: ResourceId, key: str, outcome: ExtractionOutcome) -> None:
        """Keep an outcome under the checksum of the bytes it was derived from, having stated this store's stamp.

        A write that returns has been kept. Raises `ValueError` for an
        outcome that makes no entry (`ValidationError` is one), before
        anything is sent; `StoreFailed` where the Archivist did not keep it,
        bytes the resource no longer has among them.
        """
        body = _compact({"contentChecksum": key, "entry": _entry_of(outcome, self._stamp)}).encode("utf-8")
        await self._state_stamp()
        try:
            answer = await self._asked("PUT", f"/resources/{resource_id}/anchored-text", body=body)
        except StoreFailed as failure:
            raise StoreFailed(f"the anchored text of {resource_id} for {key} was not kept: {failure}") from failure
        if answer.status_code != _DONE:
            raise StoreFailed(f"the Archivist did not keep the anchored text of {resource_id} for {key}: {_said(answer)}")

    # The last member of the class: below this one, `list` in a signature would name this method.
    @override
    async def list(self) -> list[str]:
        """Every key `read` would answer an outcome for, in order, having stated this store's stamp.

        Raises `StoreFailed` where they could not be listed.
        """
        await self._state_stamp()
        answer = await self._asked("GET", "/anchored-text/entries")
        if answer.status_code != _OK:
            raise StoreFailed(f"the Archivist did not list the anchored-text store: {_said(answer)}")
        try:
            return sorted(AnchoredTextEntries.model_validate_json(answer.content).checksums)
        except ValidationError as failure:
            raise StoreFailed(f"the Archivist's listing of the anchored-text store is no listing: {failure}") from failure
