"""A provider that asks nobody: it answers a vector worked out from the text. For tests."""

import asyncio
import math
from collections.abc import Sequence
from typing import Final, final

__all__ = ["MockEmbeddingProvider", "deterministic_vector"]


def deterministic_vector(text: str, dimensions: int) -> list[float]:
    """The vector `MockEmbeddingProvider` answers for `text`: `dimensions` numbers, the same every time, and of length one.

    A test states the vector it expects with this, and so without asking the
    provider it is testing.

    The number at each place is worked out from the place and from one code
    point of the text: the text's code points are taken in turn, and from
    the first again when they run out. So no more of a text is read than its
    first `dimensions` code points, and two texts that begin alike for that
    long are given the same vector. Nothing is claimed of what the vectors
    say: texts alike in meaning are no nearer than any others.

    An empty text has no code point to take, and is given the vector of a
    text whose every code point is 0. A vector whose numbers are all 0 is
    answered as it is, since nothing of length one can be made of it: that
    is an empty text, or one that begins with the code point 0, at one
    dimension.
    """
    points = [ord(character) for character in text] or [0]
    vector = [math.sin(points[place % len(points)] + place * 0.1) * 0.5 for place in range(dimensions)]
    norm = math.sqrt(sum(number * number for number in vector))
    return [number / norm for number in vector] if norm > 0 else vector


@final
class MockEmbeddingProvider:
    """Answers each text with `deterministic_vector` of it, `dimensions` wide, and asks nobody.

    A text is answered the same vector whichever method asks: what a text is
    for changes nothing here.
    """

    def __init__(self, *, dimensions: int) -> None:
        self._dimensions: Final = dimensions

    async def embed_query(self, text: str) -> list[float]:
        await self._turn()
        return deterministic_vector(text, self._dimensions)

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        await self._turn()
        return [deterministic_vector(text, self._dimensions) for text in texts]

    async def dimensions(self) -> int:
        return self._dimensions

    async def _turn(self) -> None:
        # A real provider waits on a request, so a cancellation asked of its caller lands inside the call.
        # This has nothing to wait on, and gives the loop one turn so that the same is true of it.
        await asyncio.sleep(0)
