"""How the worker runs the Typst compiler, held against a stand-in for it.

A `typst` that is a shell script is put first on `PATH`: it keeps what it was
run with and does as its test says. So these hold the worker's side of the
call on any machine, with or without the compiler: the arguments and their
order, the creation time every compile pins, the source as the compiler finds
it, the bytes answered, what is answered of a refusal, and that nothing is
left behind. `test_typst_binary.py` runs the compiler itself.
"""

import os
import tempfile
from pathlib import Path
from typing import Final, final

import pytest

from semiont_worker.generation.typst import PINNED_CREATION_TIMESTAMP, Compiled, NotCompiled, compile_typst

SOURCE: Final = "= Caf\u00e9 \U0001f600\r\n\r\nBody text.\n"


@final
class StandIn:
    """A `typst` first on `PATH` that does as it is told, and the directories around one compile."""

    def __init__(self, root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.kept: Final = root / "kept"
        self.scratch: Final = root / "scratch"
        self._bin: Final = root / "bin"
        for directory in (self.kept, self.scratch, self._bin):
            directory.mkdir()
        monkeypatch.setenv("PATH", f"{self._bin}{os.pathsep}{os.environ['PATH']}")
        # Where a compile makes its directory.
        monkeypatch.setattr(tempfile, "tempdir", str(self.scratch))

    def does(self, body: str) -> None:
        """Install the stand-in. It keeps its arguments, one to a line, and the source it was pointed at, and then runs `body`."""
        script = self._bin / "typst"
        script.write_text(
            f"#!/bin/sh\nprintf '%s\\n' \"$@\" > '{self.kept}/argv'\ncat \"$4\" > '{self.kept}/source'\n{body}\n", encoding="utf-8"
        )
        script.chmod(0o755)

    def argv(self) -> list[str]:
        return (self.kept / "argv").read_text(encoding="utf-8").splitlines()


@pytest.fixture
def typst(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> StandIn:
    return StandIn(tmp_path, monkeypatch)


def test_a_source_is_compiled_with_the_creation_time_pinned_and_the_compiler_s_bytes_are_answered(typst: StandIn) -> None:
    # The bytes are no text: a PDF is not.
    typst.does("printf '%%PDF-STAND-IN\\000\\377' > \"$5\"")

    assert compile_typst(SOURCE) == Compiled(pdf=b"%PDF-STAND-IN\x00\xff")

    subcommand, option, timestamp, source, pdf = typst.argv()
    assert (subcommand, option, timestamp) == ("compile", "--creation-timestamp", str(PINNED_CREATION_TIMESTAMP))
    # The source and the PDF are side by side, in a directory made for this one compile.
    assert (Path(source).name, Path(pdf).name) == ("doc.typ", "doc.pdf")
    assert Path(source).parent == Path(pdf).parent
    assert Path(source).parent.parent == typst.scratch
    assert Path(source).parent.name.startswith("typst-")
    # The compiler found the source as it was given, in UTF-8, its line ends untouched.
    assert (typst.kept / "source").read_bytes() == SOURCE.encode("utf-8")


def test_a_source_the_compiler_refuses_answers_what_the_compiler_said(typst: StandIn) -> None:
    said = "error: unclosed delimiter\n  \u250c\u2500 doc.typ:3:9\n  \u2502\n3 \u2502 #let broken = [unclosed\n  \u2502               ^\n\n"
    typst.does(f"echo 'not the diagnostics'\nprintf '%s' '{said}' >&2\nexit 1")

    assert compile_typst("#let broken = [unclosed") == NotCompiled(error=said)


def test_what_the_compiler_said_is_read_as_utf_8_and_a_byte_that_is_none_is_replaced(typst: StandIn) -> None:
    typst.does("printf 'error: \\377 here\\n' >&2\nexit 1")

    assert compile_typst(SOURCE) == NotCompiled(error="error: \ufffd here\n")


def test_a_compiler_that_refuses_and_says_nothing_answers_the_status_it_exited_with(typst: StandIn) -> None:
    typst.does("exit 3")

    assert compile_typst(SOURCE) == NotCompiled(error="typst exited with status 3 and said nothing")


def test_what_the_compiler_says_of_a_source_it_compiles_is_no_refusal(typst: StandIn) -> None:
    typst.does("echo 'warning: unknown font family: no such font' >&2\nprintf '%%PDF-WARNED' > \"$5\"")

    assert compile_typst(SOURCE) == Compiled(pdf=b"%PDF-WARNED")


@pytest.mark.parametrize("body", ["printf '%%PDF-STAND-IN' > \"$5\"", "echo 'error: refused' >&2\nexit 1"], ids=["compiled", "refused"])
def test_nothing_is_left_of_a_compile_s_directory_however_it_ended(typst: StandIn, body: str) -> None:
    typst.does(body)

    compile_typst(SOURCE)

    # The compile was made, in a directory of its own, and that directory is gone.
    assert Path(typst.argv()[3]).parent.parent == typst.scratch
    assert list(typst.scratch.iterdir()) == []


def test_a_machine_without_the_compiler_fails_loudly_and_blames_no_source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # No source is at fault where nothing compiled it: the failure is the machine's, and is not answered as a refusal to repair.
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))

    with pytest.raises(FileNotFoundError, match="typst"):
        compile_typst(SOURCE)
    assert list(tmp_path.iterdir()) == []


def test_a_compiler_that_exits_well_and_leaves_no_pdf_fails_loudly(typst: StandIn) -> None:
    typst.does("exit 0")

    with pytest.raises(FileNotFoundError, match=r"doc\.pdf"):
        compile_typst(SOURCE)
    assert list(typst.scratch.iterdir()) == []
