"""The stamp entries of the anchored-text store are written under: which reader and which engine derived them.

An entry is taken only under the stamp it was written with. So each part of
the stamp is read from what is installed, and none is written by hand: a part
that changed and was not stated would leave a text derived by other code
served as this code's. The Smelter's own version is no part of it: a release
of the Smelter leaves what its reader and its engine derived as it was.
"""

from semiont_smelter.ocr_engine import OcrEngine
from semiont_smelter.pdf_reader import PdfReader

__all__ = ["current_stamp"]


async def current_stamp(reader: PdfReader, engine: OcrEngine) -> str:
    """The stamp of this reader with this engine: `<the reader's stamp>+<the engine's>`."""
    return f"{await reader.stamp()}+{await engine.stamp()}"
