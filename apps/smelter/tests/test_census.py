"""What this project is made of, each part held to its rule.

Its public names are the ones its design lists, and no others. Hand-written
code states no type by force: it has no `cast`, names no `Any`, and silences
no checker. What reads a PDF and what reads an image are each behind a
protocol: PDFium's binding is named by the one module that asks through it,
a program is started by the one module that runs one, and the rules that
make a document's text know neither. Every reader and every engine has its
protocol's members. And what this project's manifest says a second time,
after the SDK's, says the same.
"""

import ast
import importlib
import re
import tomllib
from pathlib import Path

from pydantic import JsonValue, TypeAdapter
from spec import PACKAGE, SDK

from semiont_smelter.ocr_engine import OcrEngine
from semiont_smelter.pdf_reader import PdfReader
from semiont_smelter.pdfium import PdfiumReader
from semiont_smelter.scripted import ScriptedOcrEngine, ScriptedPdfReader
from semiont_smelter.tesseract import TesseractEngine

SRC = PACKAGE / "src/semiont_smelter"
SOURCES = sorted(path for top in ("src", "tests") for path in (PACKAGE / top).rglob("*.py"))

# The public names, by the module that has each.
SURFACE = {
    "pdf_reader": ["FormField", "Matrix", "PdfDocument", "PdfEncrypted", "PdfReader", "PdfUnreadable", "Pixels", "PlacedImage", "Run"],
    "ocr_engine": ["Box", "OcrEngine", "OcrLine", "OcrParagraph", "OcrRead", "OcrWord"],
    "scripted": ["ScriptedDocument", "ScriptedImage", "ScriptedOcrEngine", "ScriptedPage", "ScriptedPdfReader"],
    "pdfium": ["PdfiumReader"],
    "tesseract": ["TesseractEngine"],
    "anchoring": ["anchor_runs", "apply"],
    "tables": ["TableCell", "detect_table", "render_table"],
    "ocr_text": ["ImageText", "ReadWord", "assemble", "place"],
    "extraction": ["LARGEST_PDF_BYTES", "PdfExtractor"],
    "shard": ["shard_path"],
    "stamp": ["current_stamp"],
    "anchored_text_store": ["AnchoredTextStore"],
}

# The modules that say what a reader and an engine are, and the rules that make a document's text from what one hands over.
PROTOCOLS = {"pdf_reader.py", "ocr_engine.py"}
RULES = {"anchoring.py", "tables.py", "ocr_text.py", "extraction.py"}

FORCED = re.compile(r"\bcast\(|#\s*type:\s*ignore|#\s*pyright:\s*ignore|#\s*noqa\b|\btyping\.Any\b|^\s*from typing import [^\n]*\bAny\b")

type Toml = dict[str, JsonValue]

_TOML = TypeAdapter[Toml](Toml)


def toml(path: Path) -> Toml:
    """The table a TOML file holds."""
    with path.open("rb") as file:
        return _TOML.validate_python(tomllib.load(file))


def table(of: JsonValue, what: str) -> Toml:
    assert isinstance(of, dict), f"{what} is not a table"
    return of


def listed(of: JsonValue, what: str) -> list[str]:
    assert isinstance(of, list), f"{what} is not a list"
    found: list[str] = []
    for item in of:
        assert isinstance(item, str), f"{what} holds something that is not text"
        found.append(item)
    return found


def name_of(requirement: str) -> str:
    """The distribution a requirement names, without its extras and its versions."""
    return re.split(r"[\[=<>!~ ]", requirement, maxsplit=1)[0]


def importing(library: str) -> list[str]:
    """The modules of this project that import `library`, by their paths in it."""
    names_it = re.compile(rf"^\s*(import|from)\s+{library}\b", re.MULTILINE)
    return sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*.py") if names_it.search(path.read_text(encoding="utf-8")))


def naming(text: str) -> list[str]:
    """The modules of this project whose source holds `text`, by their paths in it."""
    return sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*.py") if text in path.read_text(encoding="utf-8"))


def public(thing: object) -> set[str]:
    return {name for name in dir(thing) if not name.startswith("_")}


MANIFEST = toml(PACKAGE / "pyproject.toml")


def test_the_walk_found_the_project() -> None:
    assert len(SOURCES) > 20


def test_the_public_modules_and_their_names_are_the_ones_the_design_lists() -> None:
    modules = sorted(path.stem for path in SRC.glob("*.py") if not path.stem.startswith("_"))
    assert modules == sorted(SURFACE)
    for module, names in SURFACE.items():
        assert sorted(importlib.import_module(f"semiont_smelter.{module}").__all__) == sorted(names), f"semiont_smelter.{module}"


def test_a_public_name_is_imported_from_its_module_and_not_from_the_packages_root() -> None:
    # One path to each name, as the SDK has it. It is also why importing the package starts no reader and no engine.
    # Read as Python, and not as text: a docstring may have a line that begins with the word "from".
    root_statements = ast.parse((SRC / "__init__.py").read_text(encoding="utf-8")).body
    assert not [held for held in root_statements if isinstance(held, ast.Import | ast.ImportFrom)], "the package's root imports something"
    root = importlib.import_module("semiont_smelter")
    assert not hasattr(root, "__all__")
    for module, names in SURFACE.items():
        for name in names:
            assert not hasattr(root, name), f"{name} can be imported from the package's root as well as from semiont_smelter.{module}"
    assert (SRC / "py.typed").read_bytes() == b""


def test_a_reader_and_an_engine_have_the_members_of_their_protocols() -> None:
    reads = public(PdfReader)
    assert reads == {"open", "stamp"}
    # Making a reader loads nothing: PDFium is started when a reader is first asked something.
    assert public(PdfiumReader()) == reads
    engine = public(OcrEngine)
    assert engine == {"read", "stamp"}
    assert public(TesseractEngine()) == engine
    # A scripted one has what a test reads of it besides: what it was asked.
    assert public(ScriptedPdfReader({})) == reads | {"opened", "closed", "decoded"}
    assert public(ScriptedOcrEngine()) == engine | {"asked"}


def test_no_hand_written_line_forces_a_type_or_silences_a_checker() -> None:
    forced = [
        f"{path.relative_to(PACKAGE)}:{number}: {line.strip()}"
        for path in SOURCES
        if path.name != "test_census.py"
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if FORCED.search(line)
    ]
    assert forced == []


def test_each_engine_is_reached_by_one_module_and_the_rules_know_neither() -> None:
    # PDFium's binding states no types, so it is looked up by name and never imported by one. One module names it.
    assert importing("pypdfium2") == []
    assert naming("pypdfium2") == ["pdfium.py"]
    # A program is started by the one module that runs the OCR engine, and by no library that would start one unseen.
    assert naming("create_subprocess") == ["tesseract.py"]
    assert importing("subprocess") == []
    for driver in ("pdfium", "tesseract", "scripted"):
        imported_by = set(importing(rf"semiont_smelter\.{driver}"))
        # What a reader and an engine are is said without one, and the rules are handed theirs.
        assert not imported_by & (PROTOCOLS | RULES), driver
    # The store keeps what was derived, and knows nothing of how: it imports no reader, no engine and no rule.
    kept_by = {"anchored_text_store.py", "shard.py"}
    for module in ("pdfium", "tesseract", "scripted", "extraction", "anchoring", "tables", "ocr_text", "pdf_reader", "ocr_engine"):
        assert not set(importing(rf"semiont_smelter\.{module}")) & kept_by, module


def test_the_package_holds_nothing_beside_its_modules_but_its_typed_marker() -> None:
    beside = sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*") if path.is_file() and path.suffix not in (".py", ".pyc"))
    assert beside == ["py.typed"]


def test_the_checkers_and_their_strictness_are_the_sdks() -> None:
    # This project's manifest states them a second time. A pin or a setting moved in one and not the other fails here.
    theirs = toml(SDK / "pyproject.toml")

    def tools(of: Toml) -> dict[str, str]:
        dev = listed(table(of["dependency-groups"], "dependency-groups")["dev"], "dev")
        return {name_of(requirement): requirement for requirement in dev}

    checkers = ("mypy", "pyright", "pytest", "ruff")
    assert set(tools(MANIFEST)) == set(checkers)
    assert tools(MANIFEST) == {name: tools(theirs)[name] for name in checkers}

    def settings(of: Toml, tool: str, *, but: tuple[str, ...]) -> Toml:
        return {key: value for key, value in table(table(of["tool"], "tool")[tool], tool).items() if key not in but}

    # What each reads is its own project's; everything else is the same.
    assert settings(MANIFEST, "mypy", but=("files",)) == settings(theirs, "mypy", but=("files",))
    assert settings(MANIFEST, "pydantic-mypy", but=()) == settings(theirs, "pydantic-mypy", but=())
    assert settings(MANIFEST, "pytest", but=()) == settings(theirs, "pytest", but=())
    assert settings(MANIFEST, "pyright", but=("include",)) == settings(theirs, "pyright", but=("include",))
    # The SDK's formatter is told which of its modules are generated, and its linter which of its tests are
    # programs that must not type-check. This project has neither.
    assert settings(MANIFEST, "ruff", but=("lint",)) == settings(theirs, "ruff", but=("lint", "extend-exclude"))
    our_lint = table(settings(MANIFEST, "ruff", but=())["lint"], "ruff's lint")
    their_lint = table(settings(theirs, "ruff", but=())["lint"], "ruff's lint")
    assert our_lint == {key: value for key, value in their_lint.items() if key != "per-file-ignores"}
    # Which Pythons the two run on is lint:python-version's to hold: it is the one gate that reads that line.
    assert MANIFEST["build-system"] == theirs["build-system"]


def test_what_the_project_requires_is_what_it_reads_a_pdf_with_and_what_the_sdk_brings() -> None:
    project = table(MANIFEST["project"], "project")
    required = listed(project["dependencies"], "dependencies")
    assert {name_of(requirement) for requirement in required} == {"pydantic", "pypdfium2", "semiont", "semiont-service"}
    for library in ("pydantic", "semiont"):
        assert importing(library), f"{library} is required and nothing imports it"
    # A dependency the SDK bounds is named here without a bound of its own.
    of_the_sdk = listed(table(toml(SDK / "pyproject.toml")["project"], "project")["dependencies"], "the SDK's dependencies")
    bounded = {name_of(requirement) for requirement in of_the_sdk}
    assert "pydantic" in bounded
    for requirement in required:
        if name_of(requirement) in bounded:
            assert requirement == name_of(requirement), f"{requirement}: the SDK states the versions of {name_of(requirement)}"
    # PDFium's binding is this project's own, and is bounded here: the reader leans on what one version of it has.
    (binding,) = [requirement for requirement in required if name_of(requirement) == "pypdfium2"]
    assert binding != "pypdfium2"
    # What reads a scanned page is a program, and no package: nothing here can require it.
    assert "optional-dependencies" not in project
