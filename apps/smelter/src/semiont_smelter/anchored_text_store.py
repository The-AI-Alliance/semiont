"""The anchored-text store: what was derived from some bytes, kept in a file under the checksum of those bytes.

Deriving the text of a PDF costs seconds for each page that is read from
pixels, and the same text is asked for again and again. So what was derived
is kept: a text with where each of its words is and how it was derived, or
the decline that came of trying. The Smelter writes an entry, and it and the
Archivist read it. Everything kept is derived from the bytes, so an entry
that is not taken costs deriving it again, and nothing else.

An entry is the file `<ab>/<cd>/<key>.json` under the store's directory: the
key is the SHA-256 of the bytes in hex, and `semiont_service.shard` says
where it is filed. It holds the protocol's `AnchoredTextEntry` as compact
JSON, `v` and `stamp` first. An entry is its outcome's members, by the names
the wire gives them, without `kind`, which the entry's own shape says, and
with the items packed as lines. Each entry is held to the SDK's model of it
before it is written, and is read through that model.

An entry's bytes are those of the document the model was shown, and not
those of the model. The model holds a word as four fractions, and written
from it a word's offsets would be `0.0` and `5.0`. The Archivist hands a
word's offsets on as they are stored, to readers that take only a whole
number for one.

An entry is taken only under the stamp it was written with, which says which
Smelter, which reader of PDFs and which engine derived it
(`semiont_smelter.stamp`). The Archivist cannot work a stamp out, so the
store states its own in the file `STAMP` at the directory's root, the stamp
and a line feed, before it writes an entry or lists any, whenever the file
does not hold it already.

`list` reads no entry whole. It names a key where a file is where that key's
entry is kept and begins with the bytes every entry of this stamp begins
with: its version and its stamp. `write` makes those bytes, by the function
`list` compares with, and a file comes to an entry's name whole: it is
written beside the name and moved onto it. So a key that is listed is read,
as long as `write` alone puts files there and none is cut short afterwards.
What `list` does not recognise it passes over. Nothing here deletes an
entry.

Reading and writing files is work, and no wait: it is done off the loop, at
`_off_loop` and nowhere else.
"""

import asyncio
import contextlib
import json
import os
import re
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Final, final

from pydantic import JsonValue, TypeAdapter
from semiont.model import written
from semiont.types import (
    AnchoredTextDeclinedEntry,
    AnchoredTextEntry,
    AnchoredTextExtractedEntry,
    ExtractedText,
    ExtractionOutcome,
    PdfTextItem,
)
from semiont_service.shard import shard_path

__all__ = ["AnchoredTextStore"]

_VERSION: Final = 3
"""The entry format, which says what an entry's numbers mean. The entry's model takes no other."""

_STAMP_FILE: Final = "STAMP"
"""The file in which the store states its stamp, for a reader that cannot work the stamp out."""

_ENTRY_SUFFIX: Final = ".json"

_VALID_KEY: Final = re.compile(r"[A-Za-z0-9_-]+")
"""A key the store files: letters, digits, `_` and `-`. Any other is refused whole, and no part of it is dropped to make one."""

_SHARD_NAME: Final = re.compile(r"[0-9a-f]{2}")
"""The name of a directory entries are filed under, at either level."""

_ENTRY: Final = TypeAdapter[AnchoredTextEntry](AnchoredTextEntry)
_OUTCOME: Final = TypeAdapter[ExtractionOutcome](ExtractionOutcome)


async def _off_loop[**P, T](work: Callable[P, T], *arguments: P.args, **named: P.kwargs) -> T:
    """Do file work off the loop, on a thread (`asyncio.to_thread`). Every call of the store comes through here."""
    return await asyncio.to_thread(work, *arguments, **named)


def _compact(document: dict[str, JsonValue]) -> str:
    """A document as compact JSON, its members in the order they were put in.

    Raises `ValueError` for a number that is not finite: JSON has none.
    """
    return json.dumps(document, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _head(stamp: str) -> bytes:
    """The bytes every entry of a stamp begins with: its version, its stamp, and the comma before its next member."""
    return (_compact({"v": _VERSION, "stamp": stamp})[:-1] + ",").encode("utf-8")


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


def _held(path: Path) -> bytes | None:
    """What a file holds. `None` for one that is not there, or cannot be read."""
    try:
        return path.read_bytes()
    except OSError:
        return None


def _begins(path: Path, head: bytes) -> bool:
    """Whether a file begins with `head`. No more of it is read than that. False for what is no file, or cannot be read."""
    try:
        with path.open("rb") as file:
            return file.read(len(head)) == head
    except OSError:
        return False


def _names(directory: Path) -> list[str]:
    """The names in a directory. None for a directory that is not there, or cannot be read."""
    try:
        return os.listdir(directory)
    except OSError:
        return []


def _put(path: Path, content: bytes) -> None:
    """Write a file whole: beside its name, under a name no other write has, and then moved onto its name.

    A reader finds the file as it was or as it is, and never half of it, and
    two writes of one file at once do not write into each other. Raises
    `OSError` where the file cannot be written, and leaves nothing beside it.
    """
    beside = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        beside.write_bytes(content)
        beside.replace(path)
    except OSError:
        with contextlib.suppress(OSError):
            beside.unlink(missing_ok=True)
        raise


@final
class AnchoredTextStore:
    """The entries under one directory, as one stamp reads and writes them. See the module's documentation.

    Raises `ValueError` for a stamp that is empty or has space around it:
    the Archivist reads the stated stamp without the space around it, and
    would take no entry written under such a one.
    """

    def __init__(self, directory: Path, *, stamp: str) -> None:
        if stamp == "" or stamp != stamp.strip():
            raise ValueError(f"an anchored-text store's stamp is text with no space around it, and {stamp!r} is not")
        self._directory: Final = directory
        self._stamp: Final = stamp
        self._head: Final = _head(stamp)

    def _path_of(self, key: str) -> Path | None:
        """Where a key's entry is kept. `None` for a key the store refuses."""
        if _VALID_KEY.fullmatch(key) is None:
            return None
        ab, cd = shard_path(key)
        return self._directory / ab / cd / f"{key}{_ENTRY_SUFFIX}"

    def _state_stamp(self) -> None:
        """State this store's stamp in the directory, unless the directory states it already. Raises `OSError` where it cannot."""
        stated = f"{self._stamp}\n".encode()
        path = self._directory / _STAMP_FILE
        if _held(path) != stated:
            self._directory.mkdir(parents=True, exist_ok=True)
            _put(path, stated)

    def _read(self, key: str) -> ExtractionOutcome | None:
        path = self._path_of(key)
        if path is None:
            return None
        try:
            entry = _ENTRY.validate_json(path.read_bytes())
            return _outcome_of(entry) if entry.stamp == self._stamp else None
        except (OSError, ValueError):
            # Not there, not readable, cut short, no JSON or no entry: each is a miss. What a model refuses is a `ValueError`.
            return None

    def _write(self, key: str, outcome: ExtractionOutcome) -> None:
        path = self._path_of(key)
        if path is None:
            raise ValueError(f"the anchored-text store files nothing under the key {key!r}")
        content = _compact(_entry_of(outcome, self._stamp)).encode("utf-8")
        self._state_stamp()
        path.parent.mkdir(parents=True, exist_ok=True)
        _put(path, content)

    def _list(self) -> list[str]:
        # The stamp is stated before its entries are counted as there: a Smelter that finds every text derived
        # writes none, and the Archivist takes an entry only under a stamp that is stated.
        with contextlib.suppress(OSError):
            self._state_stamp()
        keys: list[str] = []
        for ab in _names(self._directory):
            if _SHARD_NAME.fullmatch(ab) is None:
                continue
            for cd in _names(self._directory / ab):
                if _SHARD_NAME.fullmatch(cd) is None:
                    continue
                for name in _names(self._directory / ab / cd):
                    path = self._directory / ab / cd / name
                    key = name.removesuffix(_ENTRY_SUFFIX)
                    # A file is a key's entry only where `read` looks for that key: under the key's own shard, by its own name.
                    if path == self._path_of(key) and _begins(path, self._head):
                        keys.append(key)
        return sorted(keys)

    async def read(self, key: str) -> ExtractionOutcome | None:
        """The outcome kept under a key, or `None` for any miss. Never raises.

        A miss is a key with no entry, an entry of another version or under
        another stamp, a file that is cut short, is no JSON or is no entry,
        and a key the store refuses. Nothing is written, and an entry that
        is not taken is left where it is.
        """
        return await _off_loop(self._read, key)

    async def write(self, key: str, outcome: ExtractionOutcome) -> None:
        """Keep an outcome under the checksum of the bytes it was derived from, having stated this store's stamp.

        A write that returns has written. Raises `ValueError` for a key
        that is not letters, digits, `_` and `-`, and for an outcome that
        makes no entry (`ValidationError` is one); `OSError` where the file
        cannot be written. Nothing is left beside the entry either way.
        """
        await _off_loop(self._write, key, outcome)

    # The last member of the class: below this one, `list` in a signature would name this method.
    async def list(self) -> list[str]:
        """Every key `read` would answer an outcome for, in order, having stated this store's stamp. Never raises.

        What is under the directory and is no entry of this stamp is passed
        over, and left there. See the module's documentation for what a
        listed key rests on.
        """
        return await _off_loop(self._list)
