"""The Tesseract engine: an image read by the `tesseract` program, which is run once for each image.

The program is the one found on the path. A subprocess is started here and
nowhere else. Nothing here reaches the network, and the program does not:
it reads the language data installed with it.

**How it is asked.** `tesseract stdin stdout --oem 1 --psm 3 -l eng tsv`,
with the image as a PNG on its standard input: the English data, the neural
engine alone (`--oem 1`), and the layout of the page found by the program
itself (`--psm 3`). The engine is named because the program's own choice
follows the data it finds: given data that holds its older engine as well,
it runs the two together, and reads other words out of the same pixels.

**What it prints.** A table, with a tab between two columns and a line
feed after each row (TSV). The first row names the columns: `level`,
`page_num`, `block_num`, `par_num`, `line_num`, `word_num`, `left`, `top`,
`width`, `height`, `conf`, `text`. Then a row for the page (level 1), and
for each block (2), paragraph (3), line (4) and word (5) the program found,
each before the rows of what is in it. `left`, `top`, `width` and `height`
are a box in the image's pixels, from its top left corner. `conf` is how
sure the program was of a word, from 0 to 100, and -1 on every other row.
`text` is a word's text, and is empty on every other row.

**What is read of it.** Each line's row gives a line and its box, and each
word's row a word of its line. A paragraph is the lines that share a page,
a block and a paragraph number, in the order printed. Every word the
program printed is handed over, one of blank text too: which words count is
not the engine's to say. An image with nothing legible in it prints the
page's row alone, and is read as nothing.

**What fails.** A program that is not installed, that exits with a failure,
or that prints anything other than that table raises `RuntimeError`, which
names the program and says what it printed. What the program says on its
standard error is not a failure by itself: it warns there of an image that
states no resolution, as these do not.

**The stamp** is the program's version, which is the first line
`tesseract --version` prints, less the program's name, and the first eight
characters of the SHA-256 of the English data it reads. The data is the
file `eng.traineddata` in the directory `tesseract --list-langs` names in
the first line it prints (`List of available languages in "..." (2):`). It
is measured when an engine is first asked for it, and kept.
"""

import asyncio
import contextlib
import hashlib
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Final, final, override

from semiont_smelter._png import png
from semiont_smelter.ocr_engine import Box, OcrEngine, OcrLine, OcrParagraph, OcrRead, OcrWord
from semiont_smelter.pdf_reader import Pixels

__all__ = ["TesseractEngine"]

_PROGRAM: Final = "tesseract"
_LANGUAGE: Final = "eng"

# What the program is run with to read one image: see the module's documentation.
_READ: Final = ("stdin", "stdout", "--oem", "1", "--psm", "3", "-l", _LANGUAGE, "tsv")

# The first row of the table the program prints, and the levels its other rows have.
_COLUMNS: Final = ("level", "page_num", "block_num", "par_num", "line_num", "word_num", "left", "top", "width", "height", "conf", "text")
_HEADER: Final = "\t".join(_COLUMNS)
_PAGE: Final = 1
_BLOCK: Final = 2
_PARAGRAPH: Final = 3
_LINE: Final = 4
_WORD: Final = 5

# The first line `tesseract --list-langs` prints, which names the directory of the language data.
_LISTED: Final = re.compile(r'List of available languages in "(.+)" \(\d+\):')

# How much of what the program printed a failure quotes.
_QUOTED: Final = 400

type _LineKey = tuple[int, int, int, int]
"""The numbers of a line's page, block and paragraph, and its own."""


async def _printed(asked: Sequence[str], given: bytes | None) -> str:
    """What the program prints on its standard output, run with `asked` and with `given` on its standard input.

    Raises `RuntimeError` where the program is not installed, where it
    exits with a failure, with what it said on its standard error, and
    where what it printed is no text.
    """
    try:
        process = await asyncio.create_subprocess_exec(
            _PROGRAM,
            *asked,
            stdin=asyncio.subprocess.DEVNULL if given is None else asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as missing:
        raise RuntimeError(f"the `{_PROGRAM}` program is not installed: it was not found on the path") from missing
    try:
        printed, said = await process.communicate(given)
    except BaseException:
        # Whoever asked has stopped waiting: the program is ended, and not left to read an image for nobody.
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        await process.wait()
        raise
    run = f"`{_PROGRAM} {' '.join(asked)}`"
    if process.returncode != 0:
        raise RuntimeError(f"{run} exited with {process.returncode}: {said.decode('utf-8', 'replace').strip()}")
    try:
        return printed.decode("utf-8")
    except UnicodeDecodeError as undecoded:
        raise RuntimeError(f"{run} printed what is no text: {undecoded}") from undecoded


def _no_table(why: str, printed: str) -> RuntimeError:
    """The failure of a program that printed something other than the table of what it read."""
    return RuntimeError(f"the `{_PROGRAM}` program printed what is no TSV of what it read ({why}): {printed[:_QUOTED]!r}")


def _read(printed: str) -> OcrRead:
    """What the program read of one image, from the table it printed. Raises `RuntimeError` for anything that is no such table."""
    rows = printed.split("\n")
    if rows[0] != _HEADER:
        raise _no_table("its first row does not name the columns", printed)
    if rows[-1] != "":
        raise _no_table("its last row has no end", printed)
    lines: dict[_LineKey, tuple[Box, list[OcrWord]]] = {}
    paragraphs: dict[tuple[int, int, int], list[_LineKey]] = {}
    for row in rows[1:-1]:
        cells = row.split("\t")
        if len(cells) != len(_COLUMNS):
            raise _no_table(f"the row {row!r} has {len(cells)} columns", printed)
        try:
            level, page, block, paragraph, line, _, left, top, width, height = (int(cell) for cell in cells[:10])
            confidence = float(cells[10])
        except ValueError as unread:
            raise _no_table(f"the row {row!r} has something else where a number belongs", printed) from unread
        box = Box(x0=left, y0=top, x1=left + width, y1=top + height)
        key = (page, block, paragraph, line)
        if level == _LINE:
            if key in lines:
                raise _no_table(f"the row {row!r} is the second of its line", printed)
            lines[key] = (box, [])
            paragraphs.setdefault((page, block, paragraph), []).append(key)
        elif level == _WORD:
            if key not in lines:
                raise _no_table(f"the word of the row {row!r} has no line before it", printed)
            lines[key][1].append(OcrWord(text=cells[11], confidence=confidence, box=box))
        elif level not in (_PAGE, _BLOCK, _PARAGRAPH):
            raise _no_table(f"the row {row!r} is of no level the program has", printed)

    def gathered(keys: list[_LineKey]) -> OcrParagraph:
        return OcrParagraph(lines=tuple(OcrLine(box=lines[key][0], words=tuple(lines[key][1])) for key in keys))

    return OcrRead(paragraphs=tuple(gathered(keys) for keys in paragraphs.values()))


def _sha256(data: Path) -> str:
    with data.open("rb") as held:
        return hashlib.file_digest(held, "sha256").hexdigest()


async def _measured() -> str:
    """The stamp, from the program that is installed and the data it reads."""
    version = (await _printed(("--version",), None)).split("\n", 1)[0]
    name, _, number = version.partition(" ")
    if name != _PROGRAM or not number:
        raise RuntimeError(f"`{_PROGRAM} --version` did not begin with the program's name and its version: {version!r}")
    listed = (await _printed(("--list-langs",), None)).split("\n", 1)[0]
    found = _LISTED.fullmatch(listed)
    if found is None:
        raise RuntimeError(f"`{_PROGRAM} --list-langs` did not begin by naming the directory of its language data: {listed!r}")
    # Hashing the data is reading a file of some twenty megabytes, and is done off the loop.
    digest = await asyncio.to_thread(_sha256, Path(found[1]) / f"{_LANGUAGE}.traineddata")
    return f"{_PROGRAM}-{number}+{_LANGUAGE}-{digest[:8]}"


@final
class TesseractEngine(OcrEngine):
    """Reads images with the `tesseract` program. See the module's documentation."""

    def __init__(self) -> None:
        self._stamp: str | None = None

    @override
    async def stamp(self) -> str:
        if self._stamp is None:
            self._stamp = await _measured()
        return self._stamp

    @override
    async def read(self, images: Sequence[Pixels]) -> list[OcrRead]:
        reads: list[OcrRead] = []
        for image in images:
            # Deflating an image is work for a processor, and is done off the loop.
            encoded = await asyncio.to_thread(png, image)
            reads.append(_read(await _printed(_READ, encoded)))
        return reads
