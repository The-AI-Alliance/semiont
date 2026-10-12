"""The stamp entries of the anchored-text store are written under, by itself.

Its parts are read from what is installed: the Smelter's own version from
its distribution, and the reader's and the engine's from each. A reader and
an engine that read nothing stand in for the real ones here. What stamp a
real one states is held by its own tests.
"""

from pathlib import Path

from aio import run
from semiont.types import ExtractionDeclined
from spec import ROOT, read, text

from semiont_smelter.anchored_text_store import AnchoredTextStore
from semiont_smelter.scripted import ScriptedOcrEngine, ScriptedPdfReader
from semiont_smelter.stamp import current_stamp

VERSION = text(read(ROOT / "version.json")["version"], "version")
"""The repository's version, which the build gives this distribution."""


def test_the_stamp_is_the_installed_smelters_version_the_readers_stamp_and_the_engines() -> None:
    stamp = run(current_stamp(ScriptedPdfReader({}), ScriptedOcrEngine()))
    assert stamp == f"smelter-{VERSION}+scripted-reader-1+scripted-engine-1"


def test_each_part_is_carried_whole_and_the_parts_are_joined_by_a_plus() -> None:
    reader = ScriptedPdfReader({}, stamp="pdfium-156.0.8076+pypdfium2-5.14.0")
    engine = ScriptedOcrEngine(stamp="tesseract-5.5.2+eng-daa0c97d")
    stamp = run(current_stamp(reader, engine))
    assert stamp == f"smelter-{VERSION}+pdfium-156.0.8076+pypdfium2-5.14.0+tesseract-5.5.2+eng-daa0c97d"


def test_another_reader_or_another_engine_is_another_stamp() -> None:
    def stamp(reader: str, engine: str) -> str:
        return run(current_stamp(ScriptedPdfReader({}, stamp=reader), ScriptedOcrEngine(stamp=engine)))

    assert len({stamp("reader-1", "engine-1"), stamp("reader-2", "engine-1"), stamp("reader-1", "engine-2")}) == 3


def test_making_the_stamp_opens_no_document_and_reads_no_image() -> None:
    reader, engine = ScriptedPdfReader({}), ScriptedOcrEngine()
    run(current_stamp(reader, engine))
    assert reader.opened == []
    assert engine.asked == []


def test_a_store_takes_the_stamp_and_states_it_in_its_directory(tmp_path: Path) -> None:
    stamp = run(current_stamp(ScriptedPdfReader({}), ScriptedOcrEngine()))
    declined = ExtractionDeclined(kind="declined", declined="encrypted")
    store = AnchoredTextStore(tmp_path, stamp=stamp)
    run(store.write("feedc0de", declined))
    assert (tmp_path / "STAMP").read_text(encoding="utf-8") == f"{stamp}\n"
    assert run(store.read("feedc0de")) == declined
