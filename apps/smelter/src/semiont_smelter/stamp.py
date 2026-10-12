"""The stamp entries of the anchored-text store are written under: which Smelter, which reader and which engine derived them.

An entry is taken only under the stamp it was written with. So each part of
the stamp is read from what is installed, and none is written by hand: a part
that changed and was not stated would leave a text derived by other code
served as this code's. The Smelter's own part is its version, whether or not
a release changed how a text is derived. A stamp that changes when nothing
did costs deriving again; one that stays when something did costs a wrong
text nobody can see.
"""

from importlib.metadata import version
from typing import Final

from semiont_smelter.ocr_engine import OcrEngine
from semiont_smelter.pdf_reader import PdfReader

__all__ = ["current_stamp"]

_DISTRIBUTION: Final = "semiont-smelter"
"""The installed distribution whose version is the Smelter's own."""


async def current_stamp(reader: PdfReader, engine: OcrEngine) -> str:
    """The stamp of this Smelter with this reader and this engine: `smelter-<its version>+<the reader's stamp>+<the engine's>`.

    Raises `PackageNotFoundError` where the Smelter is not installed: no
    part of a stamp is made up.
    """
    return f"smelter-{version(_DISTRIBUTION)}+{await reader.stamp()}+{await engine.stamp()}"
