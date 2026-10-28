"""What this project is made of, each part held to its rule.

Its public names are the ones its design lists, and no others. Hand-written
code states no type by force: it has no `cast`, names no `Any`, and silences
no checker. What reads a PDF and what reads an image are each behind a
protocol: PDFium's binding is named by the one module that asks through it,
a program is started by the one module that runs one, and the rules that
make a document's text know neither. Every reader and every engine has its
protocol's members. The events it follows are the ones the protocol lists,
and each does something. A resource that was to be indexed and was not is
concluded in one place. The index and the provider are reached through
their protocols, and no store is named. And what this project's manifest
says a second time, after the SDK's, says the same. It is a service's code
and no library: one module reads the process's environment and its
arguments, the variables it reads by name are the ones the protocol lists,
and no other project requires it.
"""

import ast
import importlib
import re
import tomllib
from pathlib import Path

from pydantic import JsonValue, TypeAdapter
from semiont.channels import PERSISTED_EVENT_TYPES
from spec import PACKAGE, ROOT, SDK

from semiont_smelter.config import SERVICE
from semiont_smelter.ocr_engine import OcrEngine
from semiont_smelter.pdf_reader import PdfReader
from semiont_smelter.pdfium import PdfiumReader
from semiont_smelter.scripted import ScriptedOcrEngine, ScriptedPdfReader
from semiont_smelter.tesseract import TesseractEngine

SRC = PACKAGE / "src/semiont_smelter"
SOURCES = sorted(path for top in ("src", "tests") for path in (PACKAGE / top).rglob("*.py"))
SHARED = ROOT / "packages/service-python"

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
    "stamp": ["current_stamp"],
    "anchored_text_store": ["AnchoredTextStore", "AnchoredTexts", "StoreFailed"],
    "chunking": ["Chunking", "Cut", "chunk_text", "cut_chunk", "estimate_tokens"],
    "log": ["LOG", "failure_said", "words_of"],
    "record": ["READ", "Record"],
    "reconcile": [
        "Embed",
        "EmbedAnnotation",
        "Embeddable",
        "Purge",
        "PurgeAnnotation",
        "Reanchor",
        "ReconcileSummary",
        "Restamp",
        "RestampAnnotation",
        "Work",
        "classify_embeddable",
        "plan_reconcile",
        "quotes_text",
    ],
    "smelter": ["ReconcileState", "Smelter"],
    "index_stamp": ["hold_to", "stamp_of"],
    "telemetry": ["points_held"],
    "config": ["SERVICE", "embedding_key_of", "read_smelter_config"],
    "service": ["CHANNELS", "boot", "main"],
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
    # The real reader and the real engine are made by the service as it starts, and by nothing else. The scripted
    # ones are for tests: nothing the service runs imports them.
    assert importing(r"semiont_smelter\.pdfium") == ["service.py"]
    assert importing(r"semiont_smelter\.tesseract") == ["service.py"]
    assert importing(r"semiont_smelter\.scripted") == []
    # The store keeps what was derived, and knows nothing of how: it imports no reader, no engine and no rule.
    kept_by = {"anchored_text_store.py"}
    for module in ("pdfium", "tesseract", "scripted", "extraction", "anchoring", "tables", "ocr_text", "pdf_reader", "ocr_engine"):
        assert not set(importing(rf"semiont_smelter\.{module}")) & kept_by, module


def test_the_events_it_does_something_with_are_the_ones_the_protocol_lists_and_each_has_its_case() -> None:
    page = (ROOT / "docs/protocol/SMELTER.md").read_text(encoding="utf-8")
    rule = re.search(r"\*\*Eleven events of the record do something:\*\*(.*?)\*Held by", page, re.DOTALL)
    assert rule is not None, "docs/protocol/SMELTER.md no longer lists the events a Smelter does something with"
    listed = re.findall(r"`([a-z]+:[a-z-]+)`", rule.group(1))
    assert len(listed) == len(set(listed)) == 11
    # What each does is one `match` over the event's type. An event of the record that has no case there is taken
    # as nothing: one the page lists and the match lacks would be passed by without a word.
    source = (SRC / "smelter.py").read_text(encoding="utf-8")
    applying = source[source.index("    async def _apply(") : source.index("    # ── Indexing a resource")]
    stated = re.findall(r"^            case (.+):$", applying, re.MULTILINE)
    cases = [name for line in stated for name in re.findall(r'"([a-z]+:[a-z-]+)"', line)]
    assert sorted(cases) == sorted(listed)
    # Each is an event of the record, by the registry's list.
    assert set(cases) <= set(PERSISTED_EVENT_TYPES)


def test_a_resource_that_is_not_indexed_is_concluded_in_one_place() -> None:
    # A resource that was to be indexed and was not is owed a line of the log, and a decline its signal and an index
    # that agrees with it. One function does what is owed and makes the value that says it was done, so nothing
    # can decide not to index a resource and say nothing.
    source = (SRC / "smelter.py").read_text(encoding="utf-8")
    assert naming("_Concluded(") == ["smelter.py"]
    assert source.count("_Concluded(") == 1
    concluding = source[source.index("    async def _conclude(") : source.index("    async def _text_of(")]
    assert "_Concluded(" in concluding
    for owed in ('"Smelter did not index resource"', '"Smelter could not read resource content"', 'outcome="skipped"'):
        assert source.count(owed) == 1, owed
        assert owed in concluding, owed
    # And one function signals: a decision is signalled the same way whoever made it.
    assert source.count("emit(SMELT_SETTLED") == 1
    assert naming("SMELT_SETTLED") == ["smelter.py"]


def test_the_index_and_the_provider_are_reached_through_their_protocols() -> None:
    # The Smelter is handed a store and a provider. It names neither a database nor a provider's own module.
    vector_modules = sorted(
        {
            found.group(1)
            for path in SRC.rglob("*.py")
            for found in re.finditer(r"^\s*from semiont_vectors\.(\w+) import ", path.read_text(encoding="utf-8"), re.MULTILINE)
        }
    )
    assert vector_modules == ["embedding", "factory", "store"]
    # Every text it has embedded is a text that is searched: it asks for the vectors of documents, and of no query.
    assert naming(".embed_documents(") == ["smelter.py"]
    assert naming(".embed_query(") == []
    # It asks for a store and a provider by what its configuration states, in the one module that reads that.
    assert importing(r"semiont_vectors\.factory") == ["service.py"]
    assert importing("qdrant_client") == []
    # What the Smelter asks of the Archivist that is not the SDK's: a resource's bytes, its annotations and the record by
    # position, by the reader every Python service has (`semiont_service.archivist`), made by the module that starts the
    # service and named, for what reads annotations, by the modules that are handed it; and the anchored-text store the
    # Archivist keeps, by the store alone, as the same account.
    assert importing("httpx") == ["anchored_text_store.py"]
    assert importing(r"semiont_service\.archivist") == ["anchored_text_store.py", "record.py", "service.py", "smelter.py"]
    assert importing(r"semiont_service\.content") == ["smelter.py"]
    # It follows the record as every follower of it does: the Smelter holds the follower, and the service its cursors' file.
    assert importing(r"semiont_service\.follower") == ["service.py"]
    assert naming("from semiont_service import follower") == ["smelter.py"]


def test_it_writes_the_index_and_the_store_and_says_three_things_and_nothing_else() -> None:
    # It records nothing, so no event is its: what it emits is a decision and the two answers of a rebuild, each
    # named where it is emitted.
    source = (SRC / "smelter.py").read_text(encoding="utf-8")
    assert naming(".emit(") == ["smelter.py"]
    emitted = sorted(set(re.findall(r"\.emit\(\s*(\w+)", source)))
    assert emitted == ["SMELT_REBUILD_ANCHORS_FAILED", "SMELT_REBUILD_ANCHORS_OK", "SMELT_SETTLED"]
    # What it asks of the record on the bus, it asks in one module, and the catalog through the package every service
    # reads it by. What it asks of the anchored-text store, on the Archivist's surface, the store asks.
    assert naming(".request(") == ["anchored_text_store.py", "record.py"]
    asked = sorted(set(re.findall(r"\.request\(\s*(\w+)", (SRC / "record.py").read_text(encoding="utf-8"))))
    assert asked == ["BROWSE_RESOURCE_REQUESTED"]
    assert naming("from semiont_service import catalog") == ["record.py"]
    # It writes, makes and takes away no file: the anchored-text store is the Archivist's, and the index is written
    # through its store.
    writes = re.compile(r'\.write_bytes\(|\.write_text\(|\.unlink\(|\.mkdir\(|\.rmdir\(|\.open\("[wax]|\bshutil\.|\btempfile\.')
    writing = sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*.py") if writes.search(path.read_text(encoding="utf-8")))
    assert writing == []


def test_one_checksum_is_worked_out_in_one_place_and_white_space_is_asked_of_one_module() -> None:
    # The checksum on the points, the key of an anchored-text entry and the checksum a decision states are one
    # value, worked out once from the bytes that were read.
    assert naming("hashlib.sha256(") == ["smelter.py"]
    assert (SRC / "smelter.py").read_text(encoding="utf-8").count("hashlib.sha256(") == 1
    # Python's own white space is another set than the protocol's: what cuts a text, what says a text is empty
    # and what says an annotation quotes nothing each ask the one module, which is every Python service's.
    own = re.compile(r"\.strip\(\)|\.lstrip\(\)|\.rstrip\(\)|\.split\(\)|\.isspace\(\)|\\s")
    for module in ("smelter.py", "reconcile.py", "chunking.py"):
        assert not own.search((SRC / module).read_text(encoding="utf-8")), f"{module} asks Python what white space is"
        assert "from semiont_service.white_space import trimmed" in (SRC / module).read_text(encoding="utf-8"), module


def test_one_module_names_the_logger_and_one_reads_the_process_s_environment() -> None:
    assert naming("getLogger(") == ["log.py"]
    reading = sorted(
        str(path.relative_to(SRC))
        for path in SRC.rglob("*.py")
        if re.search(r"\bos\.environ\b|\bos\.getenv\b|\bsys\.argv\b", path.read_text(encoding="utf-8"))
    )
    assert reading == ["service.py"]


def test_the_variables_it_reads_by_name_are_the_ones_the_protocol_lists() -> None:
    page = (ROOT / "docs/protocol/SMELTER.md").read_text(encoding="utf-8")
    section = re.search(r"^## Environment\n(.*?)^## ", page, re.DOTALL | re.MULTILINE)
    assert section is not None, "docs/protocol/SMELTER.md no longer has an Environment section"
    listed_there = {
        name
        for row in section.group(1).splitlines()
        if row.startswith("| ") and not row.startswith("| Variable")
        for name in re.findall(r"`([A-Z][A-Z0-9_]+)`", row.split("|")[1])
    }
    # Every variable the service's code names: in the two modules that say what it is started with, and in the
    # shared package it is built on. Its other modules name what PDFium calls its own things, in the same letters.
    sources = sorted([SRC / "service.py", SRC / "config.py", *(SHARED / "src").rglob("*.py")])
    assert any(path.is_relative_to(SHARED) for path in sources), "packages/service-python has no source"
    # A module's `__all__` names what it exports, in quotes too: a constant's name there is no variable read.
    texts = [re.sub(r"^__all__ = \[.*?\]$", "", path.read_text(encoding="utf-8"), flags=re.DOTALL | re.MULTILINE) for path in sources]
    read_here = {name for text in texts for name in re.findall(r'"([A-Z][A-Z0-9]*_[A-Z0-9_]+)"', text)}
    assert read_here == listed_there
    # Its service account, and what says where its telemetry goes and under what name. Its embedding provider's
    # key is in a variable its document names, and so is named by no code.
    assert read_here == {
        "SEMIONT_OIDC_CLIENT_ID",
        "SEMIONT_OIDC_CLIENT_SECRET",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_SERVICE_NAME",
        "OTEL_SDK_DISABLED",
        "OTEL_CONSOLE_EXPORTER",
        "OTEL_METRICS_EXPORTER",
        "OTEL_METRIC_EXPORT_INTERVAL",
        "SUPERVISE_EVENTS",
        "SUPERVISE_NAME",
    }


def test_the_distribution_is_named_for_the_service() -> None:
    # Its telemetry is exported under its word for itself after `semiont-`, at the version of the distribution of
    # that name (`semiont_service.observability`).
    assert table(MANIFEST["project"], "project")["name"] == f"semiont-{SERVICE}"


def test_it_is_a_service_s_code_and_no_library() -> None:
    assert not (SRC / "py.typed").exists()
    assert "Private :: Do Not Upload" in listed(table(MANIFEST["project"], "project")["classifiers"], "classifiers")
    for other in sorted(ROOT.glob("packages/*/pyproject.toml")) + sorted(ROOT.glob("apps/*/pyproject.toml")):
        if other.parent != PACKAGE:
            assert "semiont-smelter" not in other.read_text(encoding="utf-8"), f"{other.relative_to(ROOT)} requires the Smelter"


def test_the_package_holds_nothing_beside_its_modules() -> None:
    beside = sorted(str(path.relative_to(SRC)) for path in SRC.rglob("*") if path.is_file() and path.suffix not in (".py", ".pyc"))
    assert beside == []


def test_the_checkers_and_their_strictness_are_the_sdks() -> None:
    # This project's manifest states them a second time. A pin or a setting moved in one and not the other fails here.
    theirs = toml(SDK / "pyproject.toml")

    def tools(of: Toml) -> dict[str, str]:
        dev = listed(table(of["dependency-groups"], "dependency-groups")["dev"], "dev")
        return {name_of(requirement): requirement for requirement in dev}

    checkers = ("mypy", "pyright", "pytest", "ruff")
    # Beside them, what makes the histories of the property tests, which the SDK has no use for.
    assert set(tools(MANIFEST)) == {*checkers, "hypothesis"}
    assert {name: tools(MANIFEST)[name] for name in checkers} == {name: tools(theirs)[name] for name in checkers}

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


def test_what_the_project_requires_is_what_it_reads_a_pdf_with_what_it_asks_the_archivist_with_and_what_the_sdk_brings() -> None:
    project = table(MANIFEST["project"], "project")
    required = listed(project["dependencies"], "dependencies")
    assert {name_of(requirement) for requirement in required} == {
        "httpx",
        "pydantic",
        "pypdfium2",
        "semiont",
        "semiont-service",
        "semiont-vectors",
    }
    for library in ("httpx", "pydantic", "semiont", "semiont_service", "semiont_vectors"):
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
