"""Compiling Typst to a PDF.

For a PDF the model writes Typst source, and not Markdown converted to it.
This turns the source into the PDF's bytes with the `typst` binary the
worker's image ships, found on `PATH`. A source that does not compile answers
what the compiler said of it. Typst's diagnostics name the line and the
column and point at the fault, and they are what the model is handed to
repair its source by.

A PDF that cites is compiled with the end of each cited claim marked, and the
compiler is asked where each mark landed: the worker wrote the claim, so the
compiler can say where it is, and nothing need search the PDF's text for it.

The compile is not awaited: it holds its caller until the compiler exits.
"""

import json
import subprocess
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, final

from pydantic import BaseModel

PINNED_CREATION_TIMESTAMP: Final = 1_700_000_000
"""The creation time every compile states, in seconds since the start of 1970.

Left to the clock, two compiles of one source differ in their bytes. The
content's checksum then moves, and the document is embedded again though
nothing in it changed. Which instant this is does not matter. That it is
always the same one does.
"""

MAX_COMPILE_REPAIRS: Final = 2
"""How many times a source that does not compile is handed back to the model, with what the compiler said.

Each is a whole generation, paid for, and a generation is not the same
twice: so it is a bounded repair, and no retry. After the last, the job fails
with the compiler's diagnostics.
"""


@final
@dataclass(frozen=True, slots=True)
class Compiled:
    """A source that compiled."""

    pdf: bytes


@final
@dataclass(frozen=True, slots=True)
class NotCompiled:
    """A source the compiler refused."""

    error: str
    """What the compiler said, as it said it."""


def compile_typst(source: str) -> Compiled | NotCompiled:
    """The PDF `source` compiles to, or what the compiler said of a source that does not compile.

    The source is written to a directory made for the one compile, as
    `doc.typ`, compiled to `doc.pdf` beside it with the creation time pinned,
    and the directory is removed whichever way the compile ends. What the
    compiler said is its standard error, and where it said nothing there, the
    status it exited with.

    Only the compiler's own refusal is answered. A compiler that cannot be
    run, and one that exits well and leaves no PDF, raise as they are: the
    source is not at fault, and no repair of it would help.
    """
    with tempfile.TemporaryDirectory(prefix="typst-") as directory:
        in_file = Path(directory, "doc.typ")
        out_file = Path(directory, "doc.pdf")
        # As bytes: written as text, a line end would be made the machine's own.
        in_file.write_bytes(source.encode("utf-8"))
        ran = subprocess.run(
            ["typst", "compile", "--creation-timestamp", str(PINNED_CREATION_TIMESTAMP), str(in_file), str(out_file)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
        )
        if ran.returncode != 0:
            return _refused(ran)
        return Compiled(pdf=out_file.read_bytes())


@final
@dataclass(frozen=True, slots=True)
class Landed:
    """Where the compiler says a cited claim ended: on which page, and the point on the baseline just after its last character.

    In PDF points, measured as the PDF's text is: from the bottom-left corner
    of the page, `y` growing upward.
    """

    page: int
    """The page, the first being 1."""
    x: float
    y: float


@final
@dataclass(frozen=True, slots=True)
class LandedCompile:
    """A marked source that compiled: its PDF, and where each mark landed."""

    pdf: bytes
    landed: list[Landed | None]
    """One for each end marked, in the order they were given. None where the compiler gave no point a page's text is measured by."""


_LABEL: Final = "semiont-citation"
"""The label every mark carries, and the one the compiler is asked about."""


def _mark(citation: int) -> str:
    """The mark of the `citation`th end: a point the compiler records where it lays it out, and draws nothing of.

    The point is read in context, where the compiler knows it. The page's
    height is read with it, since the compiler measures from the top of the
    page and a PDF's text from the bottom. The `;` closes the mark, so that
    what follows it in the model's prose is never read as more of it.
    """
    return (
        f"#context [#metadata((citation: {citation}, page: here().position().page, x: here().position().x.pt(), "
        "y: here().position().y.pt(), height: if type(page.height) == length { page.height.pt() } else { none }))"
        f"<{_LABEL}>];"
    )


def mark_ends(source: str, ends: Sequence[int]) -> str:
    """`source` with a mark at each of `ends`, the `i`th numbered `i`. An end counts code points, as an offset does."""
    marked = source
    # From the last end back, so that a mark put in moves no end still to be marked. Of marks at one end, the later-numbered
    # goes in first: each put in at an end stands before those already there.
    for citation, end in sorted(enumerate(ends), key=lambda numbered: (numbered[1], numbered[0]), reverse=True):
        marked = marked[:end] + _mark(citation) + marked[end:]
    return marked


class _Point(BaseModel, frozen=True, extra="forbid", strict=True):
    """A mark's point, as the compiler reports it."""

    citation: int
    page: int
    x: float
    y: float
    height: float | None
    """The page's height, or None where it is `auto`, which is no length."""


def compile_typst_landing(source: str, ends: Sequence[int]) -> LandedCompile | NotCompiled:
    """The PDF `source` compiles to with each of `ends` marked, and where each mark landed; or what the compiler said.

    The marked source is compiled as `compile_typst` compiles one, with the
    creation time pinned, and the compiler is then asked about the same file,
    with the same time, where each mark landed. The PDF and the points are so
    of one layout: a mark nudges the letters beside it by a fraction of a
    point, so a point from any other compile would be off.

    Where the compile or the asking is refused, what the compiler said is
    answered, as `compile_typst` answers it.
    """
    with tempfile.TemporaryDirectory(prefix="typst-") as directory:
        in_file = Path(directory, "doc.typ")
        out_file = Path(directory, "doc.pdf")
        in_file.write_bytes(mark_ends(source, ends).encode("utf-8"))
        pinned = str(PINNED_CREATION_TIMESTAMP)
        compiled = subprocess.run(
            ["typst", "compile", "--creation-timestamp", pinned, str(in_file), str(out_file)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
        )
        if compiled.returncode != 0:
            return _refused(compiled)
        asked = subprocess.run(
            [
                "typst",
                "eval",
                f"query(<{_LABEL}>).map(it => it.value)",
                "--in",
                str(in_file),
                "--format",
                "json",
                "--creation-timestamp",
                pinned,
            ],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
        )
        if asked.returncode != 0:
            return _refused(asked)
        points = {point.citation: point for point in (_Point.model_validate(each) for each in json.loads(asked.stdout))}
        return LandedCompile(pdf=out_file.read_bytes(), landed=[_turned_over(points.get(citation)) for citation in range(len(ends))])


def _refused(ran: subprocess.CompletedProcess[bytes]) -> NotCompiled:
    """What the compiler said of a run it refused: its standard error, or where it said nothing there, the status it exited with."""
    said = ran.stderr.decode("utf-8", errors="replace")
    return NotCompiled(error=said if said else f"typst exited with status {ran.returncode} and said nothing")


def _turned_over(point: _Point | None) -> Landed | None:
    """A point the compiler measured from the top of its page, measured from the bottom: None where it has no page height to turn it by."""
    if point is None or point.height is None:
        return None
    return Landed(page=point.page, x=point.x, y=point.height - point.y)
