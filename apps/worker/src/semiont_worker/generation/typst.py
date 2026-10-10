"""Compiling Typst to a PDF.

For a PDF the model writes Typst source, and not Markdown converted to it.
This turns the source into the PDF's bytes with the `typst` binary the
worker's image ships, found on `PATH`. A source that does not compile answers
what the compiler said of it. Typst's diagnostics name the line and the
column and point at the fault, and they are what the model is handed to
repair its source by.

The compile is not awaited: it holds its caller until the compiler exits.
"""

import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Final, final

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
            said = ran.stderr.decode("utf-8", errors="replace")
            return NotCompiled(error=said if said else f"typst exited with status {ran.returncode} and said nothing")
        return Compiled(pdf=out_file.read_bytes())
