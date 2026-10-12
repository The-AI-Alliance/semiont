"""The anchored-text store, held to what it promises its caller and to what its other reader requires.

Its caller is promised that an outcome written is the outcome read, that a
miss of any kind is `None` and never a failure, that a write that returns
has written, and that a listing names the keys a read would answer for. Its
other reader is the Archivist, which reads the same files with code of its
own: what its `read_entry` requires of them is required here of every entry
written (`taken`).

Where an entry is filed is stated here as the shard table states it, and not
asked of the store's own arithmetic.
"""

import asyncio
import json
from pathlib import Path
from typing import Final

import pytest
from aio import run
from pydantic import JsonValue, TypeAdapter, ValidationError
from semiont.types import (
    AnchoredTextEntry,
    ExtractedText,
    ExtractedTextOcrConfidence,
    ExtractionDeclined,
    ExtractionOutcome,
    PdfTextItem,
)
from spec import JsonObject, objects, read

from semiont_smelter.anchored_text_store import AnchoredTextStore

STAMP: Final = "smelter-1+reader-1+engine-1"
OTHER_STAMP: Final = "smelter-1+reader-2+engine-1"

HEAD: Final = b'{"v":3,"stamp":"smelter-1+reader-1+engine-1",'
"""What every entry under `STAMP` begins with, byte for byte."""

KEY: Final = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
OTHER_KEY: Final = "3f2a9c1e7b4d4e0a9f6c5d8e1b2a7c40"
MIXED_KEY: Final = "Res_ource-ID_0123456789"

FILED: Final = {KEY: "f7/3b", OTHER_KEY: "2b/bb", MIXED_KEY: "b2/8b"}
"""Where `specs/src/archivist/shard-cases.json` says each of these keys is filed."""

ENTRY: Final = TypeAdapter[AnchoredTextEntry](AnchoredTextEntry)


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
"""An entry as the store writes one, made here by hand."""


def without(member: str) -> JsonObject:
    """The entry made by hand, less one member."""
    return {name: value for name, value in BY_HAND.items() if name != member}


def with_words(*words: JsonValue) -> JsonObject:
    """The entry made by hand, with these for the words of its one line."""
    return {**BY_HAND, "lines": [{"p": 1, "y": 720, "h": 12, "words": [*words]}]}


OF_ANOTHER_WRITER: Final[dict[str, JsonObject]] = {
    "another version": {**BY_HAND, "v": 2},
    "a version that is text": {**BY_HAND, "v": "3"},
    "another stamp": {**BY_HAND, "stamp": OTHER_STAMP},
    "no stamp": without("stamp"),
    "a decline of another version": {"v": 2, "stamp": STAMP, "declined": "encrypted"},
    "a decline under another stamp": {"v": 3, "stamp": OTHER_STAMP, "declined": "encrypted"},
}
"""What does not begin as an entry under `STAMP` begins."""

NO_ENTRIES: Final[dict[str, JsonObject]] = {
    "no text": without("text"),
    "no lines": without("lines"),
    "no method": without("method"),
    "a method there is none of": {**BY_HAND, "method": "guesswork"},
    "a member no entry has": {**BY_HAND, "kind": "extracted"},
    "a text and a decline at once": {**BY_HAND, "declined": "encrypted"},
    "a decline of no class": {"v": 3, "stamp": STAMP, "declined": "unwilling"},
    "a line with no page": {**BY_HAND, "lines": [{"y": 720, "h": 12, "words": []}]},
    "a line with a member no line has": {**BY_HAND, "lines": [{"p": 1, "y": 720, "h": 12, "words": [], "x": 72}]},
    "a word of three numbers": with_words([72, 30, 0]),
    "a word of five numbers": with_words([72, 30, 0, 5, 9]),
    "a word that is text": with_words("alpha"),
    "a word with nothing for a number": with_words([72, 30, None, 5]),
    "an offset that is no whole number": with_words([72, 30, 0.5, 5]),
    "an offset below 0": with_words([72, 30, -1, 5]),
}
"""What begins as an entry under `STAMP` does, and is none."""


def entry_file(directory: Path, key: str = KEY) -> Path:
    """Where a key's entry is kept under a store's directory, as the shard table files the key."""
    return directory / FILED[key] / f"{key}.json"


def files(directory: Path) -> list[str]:
    """Every file under a directory, by its path in it."""
    return sorted(path.relative_to(directory).as_posix() for path in directory.rglob("*") if path.is_file())


def put_by_hand(directory: Path, document: JsonObject, key: str = KEY) -> None:
    """Put a document where a key's entry is kept, as the store writes one: compact, its members in the order given."""
    path = entry_file(directory, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")


def whole(value: JsonValue, what: str) -> int:
    """`value`, which is a whole number and is written as one."""
    assert isinstance(value, int), f"{what} is not written as a whole number"
    assert not isinstance(value, bool), f"{what} is no number"
    return value


def number(value: JsonValue, what: str) -> float:
    """`value`, which is a number."""
    assert isinstance(value, int | float), f"{what} is no number"
    assert not isinstance(value, bool), f"{what} is no number"
    return value


def taken(directory: Path, key: str) -> JsonObject:
    """A key's entry, which the Archivist takes: each thing its `read_entry` requires of the files is required here.

    It reads the stamp the directory states, without the space around it,
    and takes an entry of version 3 under that stamp: a decline that is
    text, or a text, a method and lines whose words are four numbers each.
    It hands a word's offsets on as they are stored, to readers that take
    only a whole number for one: so here an offset is written as one.
    """
    stated = (directory / "STAMP").read_text(encoding="utf-8").strip()
    assert stated != ""
    entry = read(entry_file(directory, key))
    assert whole(entry["v"], "v") == 3
    assert entry["stamp"] == stated
    if "declined" in entry:
        assert isinstance(entry["declined"], str)
        return entry
    assert isinstance(entry["text"], str)
    assert isinstance(entry["method"], str)
    for line in objects(entry["lines"], "lines"):
        whole(line["p"], "p")
        number(line["y"], "y")
        number(line["h"], "h")
        words = line["words"]
        assert isinstance(words, list)
        for word in words:
            assert isinstance(word, list)
            assert len(word) == 4
            number(word[0], "x")
            number(word[1], "width")
            start = whole(word[2], "start")
            assert start >= 0
            assert whole(word[3], "end") >= start
    return entry


@pytest.mark.parametrize("outcome", list(OUTCOMES.values()), ids=list(OUTCOMES))
def test_an_outcome_is_read_back_as_it_was_written(tmp_path: Path, outcome: ExtractionOutcome) -> None:
    run(AnchoredTextStore(tmp_path, stamp=STAMP).write(KEY, outcome))
    # Another store of the same stamp reads it: what is kept is in the file, and in no store.
    assert run(AnchoredTextStore(tmp_path, stamp=STAMP).read(KEY)) == outcome


@pytest.mark.parametrize("outcome", list(OUTCOMES.values()), ids=list(OUTCOMES))
def test_every_entry_written_is_one_the_archivist_takes_and_the_schema_allows(tmp_path: Path, outcome: ExtractionOutcome) -> None:
    run(AnchoredTextStore(tmp_path, stamp=STAMP).write(KEY, outcome))

    entry = taken(tmp_path, KEY)
    assert (tmp_path / "STAMP").read_bytes() == f"{STAMP}\n".encode()
    # Which outcome it is, the entry's own shape says: no `kind` is kept.
    assert "kind" not in entry
    held = entry_file(tmp_path).read_bytes()
    ENTRY.validate_json(held)
    # `v` and `stamp` first, which is what a listing reads of an entry.
    assert held.startswith(HEAD)
    # Compact, and each number written as it is read back: one that was written whole is whole.
    assert held == json.dumps(entry, separators=(",", ":"), ensure_ascii=False).encode()


def test_an_entry_is_its_text_its_lines_and_what_the_outcome_says_of_itself_by_the_wires_names(tmp_path: Path) -> None:
    run(AnchoredTextStore(tmp_path, stamp=STAMP).write(KEY, WHOLE))
    assert read(entry_file(tmp_path)) == {
        "v": 3,
        "stamp": STAMP,
        "text": "alpha beta",
        "lines": [{"p": 1, "y": 720, "h": 12, "words": [[72, 30, 0, 5], [110, 24, 6, 10]]}],
        "method": "ocr",
        "pdfClass": "C",
        "ocrConfidence": {"mean": 91.5, "lowConfidenceWords": 1, "totalWords": 2},
        "unreadPages": [2],
    }


def test_a_decline_is_its_class_and_nothing_else(tmp_path: Path) -> None:
    run(AnchoredTextStore(tmp_path, stamp=STAMP).write(KEY, DECLINED))
    assert entry_file(tmp_path).read_bytes() == HEAD + b'"declined":"encrypted"}'


def test_an_entry_is_one_file_under_its_keys_shard_beside_the_stamp_the_store_states(tmp_path: Path) -> None:
    directory = tmp_path / "state" / "anchored-text"
    store = AnchoredTextStore(directory, stamp=STAMP)
    run(store.write(KEY, EXTRACTED))
    run(store.write(OTHER_KEY, DECLINED))
    run(store.write(MIXED_KEY, DECLINED))
    # Nothing else: what an entry was written as, beside its name, is gone once it has its name.
    assert files(directory) == sorted(["STAMP", f"f7/3b/{KEY}.json", f"2b/bb/{OTHER_KEY}.json", f"b2/8b/{MIXED_KEY}.json"])
    assert (directory / "STAMP").read_bytes() == f"{STAMP}\n".encode()


def test_a_run_of_items_that_share_a_page_a_y_and_a_height_is_one_line(tmp_path: Path) -> None:
    items = [
        item(0, 3),
        item(4, 7, x=110),
        item(8, 11, y=700),  # another y
        item(12, 15, y=700, height=9),  # the same y, and another height
        item(16, 19, y=700, height=9, page=2),  # the same y and height, on the next page
        item(20, 23),  # where the first line was: a run of its own all the same
    ]
    outcome = ExtractedText(kind="extracted", text="one two six ten elf six", items=items, method="pdf-text-layer")
    run(AnchoredTextStore(tmp_path, stamp=STAMP).write(KEY, outcome))

    assert read(entry_file(tmp_path))["lines"] == [
        {"p": 1, "y": 720, "h": 12, "words": [[72, 30, 0, 3], [110, 30, 4, 7]]},
        {"p": 1, "y": 700, "h": 12, "words": [[72, 30, 8, 11]]},
        {"p": 1, "y": 700, "h": 9, "words": [[72, 30, 12, 15]]},
        {"p": 2, "y": 700, "h": 9, "words": [[72, 30, 16, 19]]},
        {"p": 1, "y": 720, "h": 12, "words": [[72, 30, 20, 23]]},
    ]
    # No item is moved to make a line, so the items come back in the order they were given.
    assert run(AnchoredTextStore(tmp_path, stamp=STAMP).read(KEY)) == outcome


def test_a_place_that_is_no_whole_number_or_is_below_0_is_kept_as_it_is(tmp_path: Path) -> None:
    placed = item(0, 1, x=-3.5, y=71.25, width=0.5, height=11.75)
    outcome = ExtractedText(kind="extracted", text="x", items=[placed], method="ocr")
    run(AnchoredTextStore(tmp_path, stamp=STAMP).write(KEY, outcome))
    assert read(entry_file(tmp_path))["lines"] == [{"p": 1, "y": 71.25, "h": 11.75, "words": [[-3.5, 0.5, 0, 1]]}]
    assert run(AnchoredTextStore(tmp_path, stamp=STAMP).read(KEY)) == outcome


def test_a_words_offsets_are_kept_as_its_item_states_them_and_the_text_as_it_is(tmp_path: Path) -> None:
    # A face and a script capital A ahead of two words. Each is one code point and two of UTF-16's units, so the
    # first word is the code points 2 to 7 and nothing else would count it so. The store counts nothing.
    text = "\U0001f600 \U0001d49clpha beta"
    words = [item(2, 7), item(8, 12, x=110, width=24)]
    outcome = ExtractedText(kind="extracted", text=text, items=words, method="pdf-text-layer", pdf_class="A")
    run(AnchoredTextStore(tmp_path, stamp=STAMP).write(KEY, outcome))

    entry = taken(tmp_path, KEY)
    assert entry["text"] == text
    assert entry["lines"] == [{"p": 1, "y": 720, "h": 12, "words": [[72, 30, 2, 7], [110, 24, 8, 12]]}]
    # The text is kept as UTF-8, and not as escapes of UTF-16's units.
    assert text.encode("utf-8") in entry_file(tmp_path).read_bytes()
    assert run(AnchoredTextStore(tmp_path, stamp=STAMP).read(KEY)) == outcome


def test_an_entry_put_there_by_hand_is_read_as_the_outcome_its_shape_says_and_is_listed(tmp_path: Path) -> None:
    store = AnchoredTextStore(tmp_path, stamp=STAMP)
    put_by_hand(tmp_path, BY_HAND)
    put_by_hand(tmp_path, {"v": 3, "stamp": STAMP, "declined": "corrupt"}, OTHER_KEY)
    assert run(store.read(KEY)) == ExtractedText(kind="extracted", text="alpha", items=[item(0, 5)], method="ocr")
    assert run(store.read(OTHER_KEY)) == ExtractionDeclined(kind="declined", declined="corrupt")
    assert run(store.list()) == sorted([KEY, OTHER_KEY])


def test_reading_writes_nothing_and_states_no_stamp(tmp_path: Path) -> None:
    store = AnchoredTextStore(tmp_path / "never-written", stamp=STAMP)
    assert run(store.read(KEY)) is None
    assert not (tmp_path / "never-written").exists()


@pytest.mark.parametrize("document", list(OF_ANOTHER_WRITER.values()), ids=list(OF_ANOTHER_WRITER))
def test_an_entry_of_another_version_or_under_another_stamp_is_neither_read_nor_listed(tmp_path: Path, document: JsonObject) -> None:
    store = AnchoredTextStore(tmp_path, stamp=STAMP)
    put_by_hand(tmp_path, document)
    assert run(store.read(KEY)) is None
    assert run(store.list()) == []
    # A miss takes nothing away: a Smelter put back to the version that wrote the entry reads it again.
    assert read(entry_file(tmp_path)) == document


@pytest.mark.parametrize("document", list(NO_ENTRIES.values()), ids=list(NO_ENTRIES))
def test_what_is_no_entry_is_a_miss(tmp_path: Path, document: JsonObject) -> None:
    put_by_hand(tmp_path, document)
    assert run(AnchoredTextStore(tmp_path, stamp=STAMP).read(KEY)) is None


@pytest.mark.parametrize("held", [b"", b"{ this is not json", b"null", b"[]", b'"text"', b"\xff\xfe"])
def test_a_file_that_holds_no_json_object_is_neither_read_nor_listed(tmp_path: Path, held: bytes) -> None:
    store = AnchoredTextStore(tmp_path, stamp=STAMP)
    entry_file(tmp_path).parent.mkdir(parents=True)
    entry_file(tmp_path).write_bytes(held)
    assert run(store.read(KEY)) is None
    assert run(store.list()) == []


def test_an_entry_cut_short_anywhere_is_a_miss(tmp_path: Path) -> None:
    store = AnchoredTextStore(tmp_path, stamp=STAMP)
    run(store.write(KEY, WHOLE))
    entry = entry_file(tmp_path).read_bytes()
    for kept in range(len(entry)):
        entry_file(tmp_path).write_bytes(entry[:kept])
        assert run(store.read(KEY)) is None, kept


@pytest.mark.parametrize("key", ["", "../escape/attempt", "not a checksum!", "a.b", "a/b", "café", "abc\n"])
def test_a_key_that_is_not_letters_digits_underscores_and_hyphens_is_refused(tmp_path: Path, key: str) -> None:
    store = AnchoredTextStore(tmp_path, stamp=STAMP)
    with pytest.raises(ValueError, match="files nothing under the key"):
        run(store.write(key, EXTRACTED))
    assert run(store.read(key)) is None
    # Refused before anything is done: no stamp is stated, and no directory made.
    assert files(tmp_path) == []


def test_a_listing_names_the_keys_a_read_answers_for_and_no_other(tmp_path: Path) -> None:
    store = AnchoredTextStore(tmp_path, stamp=STAMP)
    assert run(store.list()) == []
    run(store.write(KEY, EXTRACTED))
    run(store.write(OTHER_KEY, DECLINED))
    run(store.write(MIXED_KEY, WHOLE))
    assert run(store.list()) == sorted([KEY, OTHER_KEY, MIXED_KEY])
    for key in (KEY, OTHER_KEY, MIXED_KEY):
        assert run(store.read(key)) is not None

    entry_file(tmp_path, OTHER_KEY).unlink()
    assert run(store.list()) == sorted([KEY, MIXED_KEY])
    assert run(store.read(OTHER_KEY)) is None


def test_a_listing_passes_over_what_is_no_entry_of_its_own_and_leaves_it_there(tmp_path: Path) -> None:
    store = AnchoredTextStore(tmp_path, stamp=STAMP)
    run(store.write(KEY, EXTRACTED))
    entry = entry_file(tmp_path).read_bytes()
    foreign = {
        f"{OTHER_KEY}.json": entry,  # an entry at the directory's root, under no shard
        f"f7/3b/{OTHER_KEY}.json": entry,  # an entry under a shard that is not its key's
        "f7/3b/not a key!.json": entry,  # a name no key has
        f"f7/3b/{KEY}.json.1234.tmp": entry,  # what a writer that was stopped left beside an entry
        "f7/3b/notes.txt": b"no entry",
        "ab/cd/garbage.json": b"not json at all",
        "f7/3/short.json": entry,  # a directory that is no shard's
        "zz/zz/aaaa1111.json": entry,
        "old/layout/of/another/depth.json": entry,
    }
    for name, held in foreign.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_bytes(held)
    # A directory where an entry would be.
    entry_file(tmp_path, OTHER_KEY).mkdir(parents=True)

    assert run(store.list()) == [KEY]
    assert run(store.read(OTHER_KEY)) is None
    for name, held in foreign.items():
        assert (tmp_path / name).read_bytes() == held, name


def test_a_listing_states_the_stamp_as_a_write_does(tmp_path: Path) -> None:
    run(AnchoredTextStore(tmp_path, stamp=STAMP).write(KEY, EXTRACTED))
    (tmp_path / "STAMP").unlink()
    # A Smelter that finds every text derived writes none: its listing is what leaves the Archivist able to take them.
    assert run(AnchoredTextStore(tmp_path, stamp=STAMP).list()) == [KEY]
    assert (tmp_path / "STAMP").read_bytes() == f"{STAMP}\n".encode()
    taken(tmp_path, KEY)


def test_a_stamp_lost_or_changed_under_a_store_is_stated_again_by_its_next_write(tmp_path: Path) -> None:
    store = AnchoredTextStore(tmp_path, stamp=STAMP)
    run(store.write(KEY, EXTRACTED))
    (tmp_path / "STAMP").unlink()
    run(store.write(OTHER_KEY, DECLINED))
    assert (tmp_path / "STAMP").read_bytes() == f"{STAMP}\n".encode()

    (tmp_path / "STAMP").write_text(STAMP, encoding="utf-8")
    run(store.write(OTHER_KEY, DECLINED))
    # The stamp and a line feed, whatever was there.
    assert (tmp_path / "STAMP").read_bytes() == f"{STAMP}\n".encode()


def test_two_stores_of_two_stamps_on_one_directory_each_read_and_list_their_own(tmp_path: Path) -> None:
    one, other = AnchoredTextStore(tmp_path, stamp=STAMP), AnchoredTextStore(tmp_path, stamp=OTHER_STAMP)
    run(one.write(KEY, EXTRACTED))
    run(other.write(OTHER_KEY, DECLINED))

    assert run(one.read(KEY)) == EXTRACTED
    assert run(one.read(OTHER_KEY)) is None
    assert run(one.list()) == [KEY]
    assert run(other.read(OTHER_KEY)) == DECLINED
    assert run(other.read(KEY)) is None
    assert run(other.list()) == [OTHER_KEY]

    # An entry under the other stamp is a miss, and deriving the text again writes over it.
    run(other.write(KEY, WHOLE))
    assert run(other.read(KEY)) == WHOLE
    assert run(other.list()) == sorted([KEY, OTHER_KEY])
    assert run(one.read(KEY)) is None
    assert run(one.list()) == []


def test_the_directory_states_the_stamp_of_the_store_that_wrote_or_listed_last(tmp_path: Path) -> None:
    one, other = AnchoredTextStore(tmp_path, stamp=STAMP), AnchoredTextStore(tmp_path, stamp=OTHER_STAMP)
    run(one.write(KEY, EXTRACTED))
    assert (tmp_path / "STAMP").read_bytes() == f"{STAMP}\n".encode()
    run(other.write(OTHER_KEY, DECLINED))
    assert (tmp_path / "STAMP").read_bytes() == f"{OTHER_STAMP}\n".encode()
    # The Archivist takes what was written under the stamp stated, and nothing written under another.
    taken(tmp_path, OTHER_KEY)
    run(one.list())
    assert (tmp_path / "STAMP").read_bytes() == f"{STAMP}\n".encode()
    taken(tmp_path, KEY)


def test_a_write_that_fails_raises_and_leaves_no_temporary_file(tmp_path: Path) -> None:
    store = AnchoredTextStore(tmp_path, stamp=STAMP)
    # A directory where the entry is to be: the entry is written beside it, and cannot be moved onto it.
    entry_file(tmp_path).mkdir(parents=True)
    with pytest.raises(OSError, match=KEY):
        run(store.write(KEY, EXTRACTED))
    assert files(tmp_path) == ["STAMP"]
    assert run(store.read(KEY)) is None
    assert run(store.list()) == []


def test_a_store_whose_directory_cannot_be_one_reads_and_lists_nothing_and_fails_a_write(tmp_path: Path) -> None:
    (tmp_path / "a-file").write_text("", encoding="utf-8")
    store = AnchoredTextStore(tmp_path / "a-file" / "anchored-text", stamp=STAMP)
    assert run(store.read(KEY)) is None
    assert run(store.list()) == []
    with pytest.raises(OSError, match="a-file"):
        run(store.write(KEY, EXTRACTED))


def test_an_item_on_a_page_that_is_no_whole_number_makes_no_entry(tmp_path: Path) -> None:
    outcome = ExtractedText(kind="extracted", text="alpha", items=[item(0, 5, page=1.5)], method="ocr")
    with pytest.raises(ValidationError):
        run(AnchoredTextStore(tmp_path, stamp=STAMP).write(KEY, outcome))
    assert files(tmp_path) == []


@pytest.mark.parametrize("place", [float("inf"), float("-inf"), float("nan")])
def test_a_number_that_is_not_finite_makes_no_entry(tmp_path: Path, place: float) -> None:
    outcome = ExtractedText(kind="extracted", text="alpha", items=[item(0, 5, x=place)], method="ocr")
    with pytest.raises(ValueError, match="JSON compliant"):
        run(AnchoredTextStore(tmp_path, stamp=STAMP).write(KEY, outcome))
    assert files(tmp_path) == []


@pytest.mark.parametrize("stamp", ["", " ", " smelter-1", "smelter-1\n"])
def test_a_stamp_that_is_empty_or_has_space_around_it_is_no_stores_stamp(tmp_path: Path, stamp: str) -> None:
    # The Archivist reads the stated stamp without the space around it: it would take no entry written under such a one.
    with pytest.raises(ValueError, match="no space around it"):
        AnchoredTextStore(tmp_path, stamp=stamp)


def test_writes_made_at_once_all_write_and_leave_nothing_beside_the_entries(tmp_path: Path) -> None:
    store = AnchoredTextStore(tmp_path, stamp=STAMP)

    async def at_once() -> None:
        await asyncio.gather(*(store.write(key, EXTRACTED) for key in (KEY, KEY, OTHER_KEY, KEY, OTHER_KEY)))

    run(at_once())
    assert files(tmp_path) == sorted(["STAMP", f"f7/3b/{KEY}.json", f"2b/bb/{OTHER_KEY}.json"])
    assert run(store.read(KEY)) == EXTRACTED
    assert run(store.read(OTHER_KEY)) == EXTRACTED
