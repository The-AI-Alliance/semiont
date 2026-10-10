"""The Typst compiler itself, run by the worker: the `typst` found on `PATH`, which is where the worker's image puts it.

`test_typst.py` holds how the worker calls a compiler. These hold what the
call is for, which only the compiler can show: a PDF comes back, the pinned
creation time is the PDF's, one source is the same bytes every time, and a
source it refuses comes back with diagnostics that name the place.

Nothing here installs the compiler or stands in for it, and no test is
skipped without it: on a machine that has no `typst` each fails, and says
where the image gets its own.
"""

import re
import shutil
from datetime import UTC, datetime
from typing import Final

import pytest
from spec import PROJECT

from semiont_worker.generation.typst import PINNED_CREATION_TIMESTAMP, Compiled, NotCompiled, compile_typst

DOCUMENT: Final = "= The Analytical Engine\n\nIt was never built, and caf\u00e9s were.\n"


@pytest.fixture(autouse=True)
def the_compiler() -> None:
    """Fail, and do not skip, where there is no compiler to run."""
    taken_from = re.findall(r"^COPY --from=(\S*typst\S*) ", (PROJECT / "Dockerfile").read_text(encoding="utf-8"), flags=re.MULTILINE)
    assert shutil.which("typst") is not None, (
        f"no `typst` on PATH: these tests run the compiler itself, which the worker's image takes from {taken_from}"
    )


def compiled(source: str) -> bytes:
    result = compile_typst(source)
    assert isinstance(result, Compiled), result
    return result.pdf


def test_a_document_compiles_to_a_pdf() -> None:
    assert compiled(DOCUMENT).startswith(b"%PDF-")


def test_the_pinned_creation_time_is_the_pdf_s() -> None:
    # A PDF states when it was made as `D:` and the instant's digits.
    pinned = datetime.fromtimestamp(PINNED_CREATION_TIMESTAMP, UTC).strftime("D:%Y%m%d%H%M%S").encode("ascii")
    stated = set(re.findall(rb"D:\d{14}", compiled(DOCUMENT)))
    assert stated == {pinned}


def test_one_source_is_the_same_bytes_every_time() -> None:
    assert compiled(DOCUMENT) == compiled(DOCUMENT)


def test_a_source_the_compiler_refuses_comes_back_with_where_it_is_wrong() -> None:
    refused = compile_typst("= Title\n#let broken = [unclosed\n")
    assert isinstance(refused, NotCompiled), refused
    # What went wrong, and the file, the line and the column it went wrong at.
    assert "error: unclosed delimiter" in refused.error
    assert "doc.typ:2:14" in refused.error
