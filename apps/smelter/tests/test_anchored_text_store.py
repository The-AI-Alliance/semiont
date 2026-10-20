"""The anchored-text store, held to what it promises its caller and to what the Archivist that keeps it requires.

Its caller is promised that an outcome written is the outcome read, that a
miss of any kind is `None` and never a failure, that a write that returns
has been kept, and that a listing names the keys a read would answer for.
The Archivist is played here over real HTTP, as `specs/src/archivist/openapi.json`
states its four operations of the store: it keeps what it is sent, and
answers it back as it was sent. What the Archivist's own reader requires of
an entry is required here of every entry sent (`taken`); that it keeps and
answers it so is the Archivist's suite's to hold.
"""

import asyncio
import json
import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from http import HTTPStatus
from types import TracebackType
from typing import Final, Self, final, override
from urllib.parse import parse_qs, urlsplit

import pytest
from aio import run
from pydantic import JsonValue, TypeAdapter, ValidationError
from semiont.errors import SemiontError, SignInError
from semiont.identifiers import ResourceId
from semiont.types import (
    AnchoredTextEntry,
    ExtractedText,
    ExtractedTextOcrConfidence,
    ExtractionDeclined,
    ExtractionOutcome,
    PdfTextItem,
)
from semiont_service.archivist import Authorizes
from spec import JsonObject, objects, text, thing

from semiont_smelter.anchored_text_store import AnchoredTextStore, StoreFailed

STAMP: Final = "reader-1+engine-1"
OTHER_STAMP: Final = "reader-2+engine-1"
TOKEN: Final = "Bearer the-smelters-own-token"
RESOURCE: Final = ResourceId("res-1")

KEY: Final = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
OTHER_KEY: Final = "3f2a9c1e7b4d4e0a9f6c5d8e1b2a7c403f2a9c1e7b4d4e0a9f6c5d8e1b2a7c40"

ENTRY: Final = TypeAdapter[AnchoredTextEntry](AnchoredTextEntry)
OBJECT: Final = TypeAdapter[JsonObject](JsonObject)


def item(start: int, end: int, *, page: float = 1, x: float = 72, y: float = 720, width: float = 30, height: float = 12) -> PdfTextItem:
    """A word of a text, at these offsets. Where nothing else is said it is on the first page, at one place."""
    return PdfTextItem(start=start, end=end, page=page, x=x, y=y, width=width, height=height)


WORDS: Final = [item(0, 5), item(6, 10, x=110, width=24)]

EXTRACTED: Final = ExtractedText(kind="extracted", text="alpha beta", items=WORDS, method="ocr")
WHOLE: Final = ExtractedText(
    kind="extracted",
    text="alpha beta",
    items=WORDS,
    method="ocr",
    pdf_class="C",
    ocr_confidence=ExtractedTextOcrConfidence(mean=91.5, low_confidence_words=1, total_words=2),
    unread_pages=[2],
)
EMPTY: Final = ExtractedText(kind="extracted", text="", items=[], method="pdf-text-layer", pdf_class="A")
DECLINED: Final = ExtractionDeclined(kind="declined", declined="encrypted")

OUTCOMES: Final[dict[str, ExtractionOutcome]] = {
    "a text": EXTRACTED,
    "a text with all an outcome may say of itself": WHOLE,
    "a text of nothing": EMPTY,
    "a decline": DECLINED,
}

LINES: Final[JsonValue] = [{"p": 1, "y": 720, "h": 12, "words": [[72, 30, 0, 5]]}]
BY_HAND: Final[JsonObject] = {"v": 3, "stamp": STAMP, "text": "alpha", "lines": LINES, "method": "ocr"}
"""An entry as the store sends one, made here by hand."""


def without(member: str) -> JsonObject:
    """The entry made by hand, less one member."""
    return {name: value for name, value in BY_HAND.items() if name != member}


def with_words(*words: JsonValue) -> JsonObject:
    """The entry made by hand, with these for the words of its one line."""
    return {**BY_HAND, "lines": [{"p": 1, "y": 720, "h": 12, "words": [*words]}]}


OF_ANOTHER_WRITER: Final[dict[str, JsonObject]] = {
    "another version": {**BY_HAND, "v": 2},
    "another stamp": {**BY_HAND, "stamp": OTHER_STAMP},
    "a decline of another version": {"v": 2, "stamp": STAMP, "declined": "encrypted"},
    "a decline under another stamp": {"v": 3, "stamp": OTHER_STAMP, "declined": "encrypted"},
}
"""What is no entry of this store's stamp and version."""

NO_ENTRIES: Final[dict[str, JsonObject]] = {
    "no text": without("text"),
    "no lines": without("lines"),
    "no method": without("method"),
    "no stamp": without("stamp"),
    "a method there is none of": {**BY_HAND, "method": "guesswork"},
    "a member no entry has": {**BY_HAND, "kind": "extracted"},
    "a text and a decline at once": {**BY_HAND, "declined": "encrypted"},
    "a decline of no class": {"v": 3, "stamp": STAMP, "declined": "unwilling"},
    "a line with no page": {**BY_HAND, "lines": [{"y": 720, "h": 12, "words": []}]},
    "a word of three numbers": with_words([72, 30, 0]),
    "a word that is text": with_words("alpha"),
    "an offset that is no whole number": with_words([72, 30, 0.5, 5]),
    "an offset below 0": with_words([72, 30, -1, 5]),
}
"""What is answered as an entry and is none."""


# ── The Archivist, played ──────────────────────────────────────────────


@final
@dataclass(frozen=True, slots=True)
class Asked:
    """One request, as it arrived."""

    method: str
    path: str
    query: Mapping[str, list[str]]
    headers: Mapping[str, str]
    body: bytes


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Said:
    """An answer a test puts in place of the played Archivist's own."""

    status: int = 500
    body: bytes = b'{"error":"internal error"}'
    hang_up: bool = False
    """Close the connection without a word."""


@final
class PlayedArchivist:
    """The Archivist's four operations of the anchored-text store, over HTTP/1.1, one request for each connection.

    It keeps each entry it is sent as it was sent, and states the stamp it
    was last told. An operation in `says`, by its method and the start of
    its path, is answered as said there instead.
    """

    def __init__(self) -> None:
        self.asked: Final[list[Asked]] = []
        self.entries: Final[dict[str, bytes]] = {}
        self.stamp: str | None = None
        self.says: Final[dict[str, Said]] = {}
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

    def put(self, key: str, document: JsonObject) -> None:
        """Keep a document under a key, as it is written here: compact, its members in the order given."""
        self.entries[key] = json.dumps(document, separators=(",", ":")).encode("utf-8")

    def sent(self, method: str, path: str) -> list[Asked]:
        """Each request of an operation, in order."""
        return [asked for asked in self.asked if asked.method == method and asked.path == path]

    def _answer(self, asked: Asked) -> tuple[int, bytes]:
        for start, said in self.says.items():
            if f"{asked.method} {asked.path}".startswith(start):
                return said.status, said.body
        if (asked.method, asked.path) == ("PUT", "/anchored-text/stamp"):
            self.stamp = text(OBJECT.validate_json(asked.body)["stamp"], "stamp")
            return 204, b""
        if (asked.method, asked.path) == ("GET", "/anchored-text/entries"):
            return 200, json.dumps({"checksums": sorted(self.entries)}).encode()
        if asked.method == "PUT":
            write = OBJECT.validate_json(asked.body)
            key = write["contentChecksum"]
            assert isinstance(key, str)
            self.entries[key] = json.dumps(write["entry"], separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            return 204, b""
        (key,) = asked.query["contentChecksum"]
        held = self.entries.get(key)
        return (404, b'{"error":"No entry is stored for this content"}') if held is None else (200, held)

    async def _connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        head = (await reader.readuntil(b"\r\n\r\n")).decode("ascii")
        request, *stated = head.split("\r\n")
        method, target, _ = request.split(" ")
        headers = {name.lower(): value for name, value in (line.split(": ", 1) for line in stated if line)}
        body = await reader.readexactly(int(headers.get("content-length", "0")))
        split = urlsplit(target)
        asked = Asked(method, split.path, parse_qs(split.query), headers, body)
        self.asked.append(asked)
        hang_up = any(f"{method} {split.path}".startswith(start) and said.hang_up for start, said in self.says.items())
        if not hang_up:
            status, answer = self._answer(asked)
            lines = [
                f"HTTP/1.1 {status} {HTTPStatus(status).phrase}",
                "Content-Type: application/json",
                f"Content-Length: {len(answer)}",
                "Connection: close",
                "",
                "",
            ]
            writer.write("\r\n".join(lines).encode("ascii") + answer)
            await writer.drain()
        writer.close()
        await writer.wait_closed()


@final
class Account(Authorizes):
    """An account that signs in as a test said: with `TOKEN`, or not at all."""

    def __init__(self, *, refused: SemiontError | None = None) -> None:
        self._refused: Final = refused

    @override
    async def authorization(self) -> str:
        if self._refused is not None:
            raise self._refused
        return TOKEN


def store_of(archivist: PlayedArchivist, *, stamp: str = STAMP, account: Account | None = None) -> AnchoredTextStore:
    """A store of the played Archivist, under a stamp."""
    return AnchoredTextStore("smelter", host="127.0.0.1", port=archivist.port, account=account or Account(), stamp=stamp)


def entry_sent(archivist: PlayedArchivist, key: str = KEY) -> JsonObject:
    """The entry the last write of a key sent, as the Archivist's reader takes it: each thing it requires is required here.

    It takes an entry of version 3 under the stamp stated: a decline that is
    text, or a text, a method and lines whose words are four numbers each.
    It hands a word's offsets on as they are stored, to readers that take
    only a whole number for one: so here an offset is sent as one.
    """
    (write,) = [OBJECT.validate_json(asked.body) for asked in archivist.sent("PUT", f"/resources/{RESOURCE}/anchored-text")][-1:]
    assert write["contentChecksum"] == key
    entry = thing(write["entry"], "entry")
    assert entry["v"] == 3
    assert not isinstance(entry["v"], bool)
    assert entry["stamp"] == archivist.stamp
    if "declined" in entry:
        assert isinstance(entry["declined"], str)
        return entry
    assert isinstance(entry["text"], str)
    assert isinstance(entry["method"], str)
    for line in objects(entry["lines"], "lines"):
        assert isinstance(line["p"], int)
        assert isinstance(line["y"], int | float)
        assert isinstance(line["h"], int | float)
        words = line["words"]
        assert isinstance(words, list)
        for word in words:
            assert isinstance(word, list)
            assert len(word) == 4
            assert all(isinstance(number, int | float) for number in word)
            start, end = word[2], word[3]
            assert isinstance(start, int)
            assert isinstance(end, int)
            assert 0 <= start <= end
    return entry


async def kept(outcome: ExtractionOutcome) -> tuple[PlayedArchivist, ExtractionOutcome | None]:
    """What a store sent of an outcome it wrote, and what a store of the same stamp reads back."""
    async with PlayedArchivist() as archivist:
        async with store_of(archivist) as store:
            await store.write(RESOURCE, KEY, outcome)
        async with store_of(archivist) as again:
            return archivist, await again.read(RESOURCE, KEY)


# ── What is sent, and what is read back ────────────────────────────────


@pytest.mark.parametrize("outcome", list(OUTCOMES.values()), ids=list(OUTCOMES))
def test_an_outcome_is_read_back_as_it_was_written(outcome: ExtractionOutcome) -> None:
    _, read = run(kept(outcome))
    assert read == outcome


@pytest.mark.parametrize("outcome", list(OUTCOMES.values()), ids=list(OUTCOMES))
def test_every_entry_sent_is_one_the_archivist_takes_and_the_schema_allows(outcome: ExtractionOutcome) -> None:
    archivist, _ = run(kept(outcome))
    entry = entry_sent(archivist)
    # Which outcome it is, the entry's own shape says: no `kind` is sent.
    assert "kind" not in entry
    ENTRY.validate_python(entry)
    (write,) = archivist.sent("PUT", f"/resources/{RESOURCE}/anchored-text")
    # `v` and `stamp` first, compact, and each number sent as it is read back: one that was whole is whole.
    head = json.dumps({"contentChecksum": KEY, "entry": {"v": 3, "stamp": STAMP}}, separators=(",", ":"))[:-2]
    assert write.body.startswith(head.encode() + b",")
    assert write.body == json.dumps({"contentChecksum": KEY, "entry": entry}, separators=(",", ":"), ensure_ascii=False).encode()


def test_an_entry_is_its_text_its_lines_and_what_the_outcome_says_of_itself_by_the_wires_names() -> None:
    archivist, _ = run(kept(WHOLE))
    assert entry_sent(archivist) == {
        "v": 3,
        "stamp": STAMP,
        "text": "alpha beta",
        "lines": [{"p": 1, "y": 720, "h": 12, "words": [[72, 30, 0, 5], [110, 24, 6, 10]]}],
        "method": "ocr",
        "pdfClass": "C",
        "ocrConfidence": {"mean": 91.5, "lowConfidenceWords": 1, "totalWords": 2},
        "unreadPages": [2],
    }


def test_a_decline_is_its_class_and_nothing_else() -> None:
    archivist, _ = run(kept(DECLINED))
    assert entry_sent(archivist) == {"v": 3, "stamp": STAMP, "declined": "encrypted"}


def test_a_run_of_items_that_share_a_page_a_y_and_a_height_is_one_line() -> None:
    items = [
        item(0, 3),
        item(4, 7, x=110),
        item(8, 11, y=700),  # another y
        item(12, 15, y=700, height=9),  # the same y, and another height
        item(16, 19, y=700, height=9, page=2),  # the same y and height, on the next page
        item(20, 23),  # where the first line was: a run of its own all the same
    ]
    outcome = ExtractedText(kind="extracted", text="one two six ten elf six", items=items, method="pdf-text-layer")
    archivist, read = run(kept(outcome))
    assert entry_sent(archivist)["lines"] == [
        {"p": 1, "y": 720, "h": 12, "words": [[72, 30, 0, 3], [110, 30, 4, 7]]},
        {"p": 1, "y": 700, "h": 12, "words": [[72, 30, 8, 11]]},
        {"p": 1, "y": 700, "h": 9, "words": [[72, 30, 12, 15]]},
        {"p": 2, "y": 700, "h": 9, "words": [[72, 30, 16, 19]]},
        {"p": 1, "y": 720, "h": 12, "words": [[72, 30, 20, 23]]},
    ]
    # No item is moved to make a line, so the items come back in the order they were given.
    assert read == outcome


def test_a_place_that_is_no_whole_number_or_is_below_0_is_kept_as_it_is() -> None:
    placed = item(0, 1, x=-3.5, y=71.25, width=0.5, height=11.75)
    outcome = ExtractedText(kind="extracted", text="x", items=[placed], method="ocr")
    archivist, read = run(kept(outcome))
    assert entry_sent(archivist)["lines"] == [{"p": 1, "y": 71.25, "h": 11.75, "words": [[-3.5, 0.5, 0, 1]]}]
    assert read == outcome


def test_a_words_offsets_are_sent_as_its_item_states_them_and_the_text_as_it_is() -> None:
    # A face and a script capital A ahead of two words. Each is one code point and two of UTF-16's units, so the
    # first word is the code points 2 to 7 and nothing else would count it so. The store counts nothing.
    text = "\U0001f600 \U0001d49clpha beta"
    words = [item(2, 7), item(8, 12, x=110, width=24)]
    outcome = ExtractedText(kind="extracted", text=text, items=words, method="pdf-text-layer", pdf_class="A")
    archivist, read = run(kept(outcome))
    entry = entry_sent(archivist)
    assert entry["text"] == text
    assert entry["lines"] == [{"p": 1, "y": 720, "h": 12, "words": [[72, 30, 2, 7], [110, 24, 8, 12]]}]
    # The text is sent as UTF-8, and not as escapes of UTF-16's units.
    (write,) = archivist.sent("PUT", f"/resources/{RESOURCE}/anchored-text")
    assert text.encode("utf-8") in write.body
    assert read == outcome


# ── What is asked of the Archivist ─────────────────────────────────────


def test_the_stamp_is_stated_once_before_the_first_write_or_listing_and_each_request_is_the_accounts() -> None:
    async def scenario() -> PlayedArchivist:
        async with PlayedArchivist() as archivist, store_of(archivist) as store:
            await store.read(RESOURCE, KEY)
            await store.write(RESOURCE, KEY, EXTRACTED)
            await store.write(RESOURCE, OTHER_KEY, DECLINED)
            await store.list()
            return archivist

    archivist = run(scenario())
    assert [(asked.method, asked.path) for asked in archivist.asked] == [
        ("GET", f"/resources/{RESOURCE}/anchored-text/stored"),
        ("PUT", "/anchored-text/stamp"),
        ("PUT", f"/resources/{RESOURCE}/anchored-text"),
        ("PUT", f"/resources/{RESOURCE}/anchored-text"),
        ("GET", "/anchored-text/entries"),
    ]
    assert archivist.asked[0].query == {"contentChecksum": [KEY]}
    assert OBJECT.validate_json(archivist.asked[1].body) == {"stamp": STAMP}
    assert all(asked.headers["authorization"] == TOKEN for asked in archivist.asked)
    assert archivist.stamp == STAMP


def test_writes_made_at_once_all_write_and_state_the_stamp_once() -> None:
    async def scenario() -> PlayedArchivist:
        async with PlayedArchivist() as archivist, store_of(archivist) as store:
            await asyncio.gather(*(store.write(RESOURCE, key, EXTRACTED) for key in (KEY, KEY, OTHER_KEY, KEY, OTHER_KEY)))
            assert await store.read(RESOURCE, KEY) == EXTRACTED
            assert await store.read(RESOURCE, OTHER_KEY) == EXTRACTED
            return archivist

    archivist = run(scenario())
    assert len(archivist.sent("PUT", "/anchored-text/stamp")) == 1
    assert len(archivist.sent("PUT", f"/resources/{RESOURCE}/anchored-text")) == 5


def test_an_entry_the_archivist_keeps_is_read_as_the_outcome_its_shape_says_and_is_listed() -> None:
    async def scenario() -> None:
        async with PlayedArchivist() as archivist, store_of(archivist) as store:
            archivist.put(KEY, BY_HAND)
            archivist.put(OTHER_KEY, {"v": 3, "stamp": STAMP, "declined": "corrupt"})
            assert await store.read(RESOURCE, KEY) == ExtractedText(kind="extracted", text="alpha", items=[item(0, 5)], method="ocr")
            assert await store.read(RESOURCE, OTHER_KEY) == ExtractionDeclined(kind="declined", declined="corrupt")
            assert await store.list() == sorted([KEY, OTHER_KEY])

    run(scenario())


# ── A miss ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("document", list(OF_ANOTHER_WRITER.values()), ids=list(OF_ANOTHER_WRITER))
def test_an_entry_of_another_version_or_under_another_stamp_is_a_miss(document: JsonObject) -> None:
    async def scenario() -> None:
        async with PlayedArchivist() as archivist, store_of(archivist) as store:
            archivist.put(KEY, document)
            assert await store.read(RESOURCE, KEY) is None

    run(scenario())


@pytest.mark.parametrize("document", list(NO_ENTRIES.values()), ids=list(NO_ENTRIES))
def test_what_is_no_entry_is_a_miss(document: JsonObject) -> None:
    async def scenario() -> None:
        async with PlayedArchivist() as archivist, store_of(archivist) as store:
            archivist.put(KEY, document)
            assert await store.read(RESOURCE, KEY) is None

    run(scenario())


@pytest.mark.parametrize(
    "said",
    [
        Said(status=404, body=b'{"error":"No entry is stored for this content"}'),
        Said(status=409, body=b'{"error":"The resource\'s content is another"}'),
        Said(status=200, body=b"{ this is not json"),
        Said(status=200, body=b"null"),
    ],
    ids=["none is kept", "the resource has other bytes", "no JSON", "no object"],
)
def test_an_answer_that_is_no_entry_is_a_miss_and_is_not_said(said: Said, caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with PlayedArchivist() as archivist, store_of(archivist) as store:
            archivist.says["GET /resources/"] = said
            assert await store.read(RESOURCE, KEY) is None

    with caplog.at_level(logging.WARNING, logger="semiont_smelter"):
        run(scenario())
    assert [record for record in caplog.records if record.name.startswith("semiont_smelter")] == []


@pytest.mark.parametrize("said", [Said(), Said(hang_up=True)], ids=["a failure of its own", "no answer"])
def test_a_read_the_archivist_could_not_answer_is_a_miss_and_is_said(said: Said, caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with PlayedArchivist() as archivist, store_of(archivist) as store:
            archivist.says["GET /resources/"] = said
            assert await store.read(RESOURCE, KEY) is None

    with caplog.at_level(logging.WARNING, logger="semiont_smelter"):
        run(scenario())
    (said_so,) = [record for record in caplog.records if record.name.startswith("semiont_smelter")]
    assert said_so.getMessage() == "An anchored-text entry was not read back, and is derived again"


# ── A failure ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "said",
    [Said(status=409, body=b'{"error":"The resource\'s content is another"}'), Said(), Said(hang_up=True)],
    ids=["the resource has other bytes", "a failure of its own", "no answer"],
)
def test_a_write_the_archivist_did_not_keep_fails_naming_the_resource_and_the_key(said: Said) -> None:
    async def scenario() -> None:
        async with PlayedArchivist() as archivist, store_of(archivist) as store:
            archivist.says["PUT /resources/"] = said
            with pytest.raises(StoreFailed, match=f"{RESOURCE}.*{KEY}"):
                await store.write(RESOURCE, KEY, EXTRACTED)

    run(scenario())


def test_a_stamp_the_archivist_did_not_take_fails_the_write_and_the_listing_and_sends_neither() -> None:
    async def scenario() -> None:
        async with PlayedArchivist() as archivist, store_of(archivist) as store:
            archivist.says["PUT /anchored-text/stamp"] = Said()
            with pytest.raises(StoreFailed, match=re.escape(STAMP)):
                await store.write(RESOURCE, KEY, EXTRACTED)
            with pytest.raises(StoreFailed, match=re.escape(STAMP)):
                await store.list()
            assert archivist.sent("PUT", f"/resources/{RESOURCE}/anchored-text") == []
            assert archivist.sent("GET", "/anchored-text/entries") == []

    run(scenario())


@pytest.mark.parametrize(
    "said", [Said(), Said(status=200, body=b'{"keys":[]}'), Said(hang_up=True)], ids=["a failure of its own", "no listing", "no answer"]
)
def test_a_listing_the_archivist_did_not_answer_fails(said: Said) -> None:
    async def scenario() -> None:
        async with PlayedArchivist() as archivist, store_of(archivist) as store:
            archivist.says["GET /anchored-text/entries"] = said
            with pytest.raises(StoreFailed):
                await store.list()

    run(scenario())


def test_an_account_that_could_not_sign_in_fails_a_write_and_misses_a_read() -> None:
    refused = Account(refused=SignInError("exchange", "Client-credentials grant for semiont-smelter failed (HTTP 401)"))

    async def scenario() -> None:
        async with PlayedArchivist() as archivist, store_of(archivist, account=refused) as store:
            with pytest.raises(StoreFailed, match="could not sign in"):
                await store.write(RESOURCE, KEY, EXTRACTED)
            assert await store.read(RESOURCE, KEY) is None
            assert archivist.asked == []

    run(scenario())


def test_an_item_on_a_page_that_is_no_whole_number_makes_no_entry_and_nothing_is_sent() -> None:
    outcome = ExtractedText(kind="extracted", text="alpha", items=[item(0, 5, page=1.5)], method="ocr")

    async def scenario() -> None:
        async with PlayedArchivist() as archivist, store_of(archivist) as store:
            with pytest.raises(ValidationError):
                await store.write(RESOURCE, KEY, outcome)
            assert archivist.asked == []

    run(scenario())


@pytest.mark.parametrize("place", [float("inf"), float("-inf"), float("nan")])
def test_a_number_that_is_not_finite_makes_no_entry_and_nothing_is_sent(place: float) -> None:
    outcome = ExtractedText(kind="extracted", text="alpha", items=[item(0, 5, x=place)], method="ocr")

    async def scenario() -> None:
        async with PlayedArchivist() as archivist, store_of(archivist) as store:
            with pytest.raises(ValueError, match="JSON compliant"):
                await store.write(RESOURCE, KEY, outcome)
            assert archivist.asked == []

    run(scenario())


@pytest.mark.parametrize("stamp", ["", " ", " reader-1", "reader-1\n", "reader 1"])
def test_a_stamp_that_is_empty_or_has_white_space_in_it_is_no_stores_stamp(stamp: str) -> None:
    # The Archivist keeps the stamp as a file of one line, and takes no stamp with white space in it.
    with pytest.raises(ValueError, match="no white space"):
        AnchoredTextStore("smelter", host="127.0.0.1", port=1, account=Account(), stamp=stamp)
