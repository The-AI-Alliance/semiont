"""The PDFs the tests read, held to the program that writes them.

`specs/src/smelter/fixtures/` is kept in the repository, so that every reader
of a fixture reads the same bytes. `tests/fixtures/scripts/make-pdf-fixtures.py`
writes all of them but one, the same bytes on every run: a fixture changed by
hand, or a program changed without its files written again, fails here.
`legible-scan.pdf` needs a typeface and is another program's
(`tests/fixtures/scripts/make-legible-scan.py`), which nothing here can run.
"""

import importlib.util
from pathlib import Path
from typing import Final, Protocol

from spec import ROOT, SPEC, read, text

FIXTURES: Final = SPEC / "smelter/fixtures"
PROGRAM: Final = ROOT / "tests/fixtures/scripts/make-pdf-fixtures.py"
DRAWN_ELSEWHERE: Final = "legible-scan.pdf"


class _Fixtures(Protocol):
    """The program's one function: every fixture's bytes, by its file's name."""

    def __call__(self) -> dict[str, bytes]: ...


def written() -> dict[str, bytes]:
    """What the program writes, asked of it without anything being written."""
    # Its file's name is no module's name, so it is loaded from where it is.
    spec = importlib.util.spec_from_file_location("make_pdf_fixtures", PROGRAM)
    assert spec is not None, f"{PROGRAM} is not a program that can be loaded"
    assert spec.loader is not None, f"{PROGRAM} has nothing to load it"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fixtures: _Fixtures = vars(module)["fixtures"]
    return fixtures()


def kept() -> dict[str, bytes]:
    """Every file of the fixtures' directory, by its name."""
    return {path.name: path.read_bytes() for path in sorted(Path(FIXTURES).iterdir()) if path.is_file()}


def test_every_fixture_kept_is_the_one_its_program_writes() -> None:
    made, held = written(), kept()
    assert sorted(held) == sorted([*made, DRAWN_ELSEWHERE])
    for name, content in made.items():
        assert held[name] == content, f"{name} is not what {PROGRAM.name} writes: run the program, and keep what it writes"


def test_every_fixture_begins_as_a_pdf_does() -> None:
    for name, content in kept().items():
        assert content.startswith(b"%PDF-"), name


def test_every_fixture_the_extraction_table_names_is_kept() -> None:
    table = read(SPEC / "smelter/extraction-cases.json")
    cases = table["cases"]
    assert isinstance(cases, list)
    named = {text(case["fixture"], "fixture") for case in cases if isinstance(case, dict) and "fixture" in case}
    assert len(named) >= 12
    assert named <= set(kept())
