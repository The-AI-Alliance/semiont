"""What reads the characters in an image, as the Smelter asks it: the words it found, and where in the image each is.

An engine hands over what it read as paragraphs of lines of words, each
word with its box and how sure the engine was of it, and each line with its
box. The text of a page, where a word is on the page and which words count
are the Smelter's own.

Boxes are in the image's own pixels, measured from its top left corner,
with y downward.

No type of an engine's library appears here, and no engine reaches the
network: its language data is installed with it.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol, final

from semiont_smelter.pdf_reader import Pixels

__all__ = ["Box", "OcrEngine", "OcrLine", "OcrParagraph", "OcrRead", "OcrWord"]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Box:
    """A rectangle of an image, from its left and top edges to its right and bottom ones."""

    x0: float
    y0: float
    x1: float
    y1: float


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class OcrWord:
    """One word an engine read."""

    text: str
    confidence: float
    """How sure the engine was of it, from 0 to 100."""
    box: Box


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class OcrLine:
    """One line of words, in the order they are read, and the box of the line as a whole."""

    box: Box
    words: tuple[OcrWord, ...]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class OcrParagraph:
    """The lines of one paragraph, from the top."""

    lines: tuple[OcrLine, ...]


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class OcrRead:
    """What an engine read of one image: its paragraphs, in the order they are read. None for an image with nothing legible in it."""

    paragraphs: tuple[OcrParagraph, ...] = ()


class OcrEngine(Protocol):
    """What reads images. Every engine has these members and no others."""

    async def stamp(self) -> str:
        """The engine's name and version, and its language data's, as the anchored-text store's stamp states them.

        Read from what is installed, and never written by hand: another
        engine, or other language data, reads other text out of the same
        pixels.
        """
        ...

    async def read(self, images: Sequence[Pixels]) -> list[OcrRead]:
        """What is read of each image, one answer for each, in the order of the images."""
        ...
