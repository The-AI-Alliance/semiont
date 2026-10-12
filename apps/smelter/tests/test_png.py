"""A PNG made of pixels, read back here by the rules of the format: its signature, its chunks and their CRCs, its header and its rows.

That the `tesseract` program reads one is held by `test_tesseract.py`.
"""

import zlib
from typing import Final

import pytest

from semiont_smelter._png import png
from semiont_smelter.pdf_reader import Pixels

SIGNATURE: Final = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])


def number(four: bytes) -> int:
    """A number as a PNG writes one: four bytes, the largest first."""
    assert len(four) == 4
    return int.from_bytes(four, "big")


def chunks(encoded: bytes) -> list[tuple[bytes, bytes]]:
    """The chunks of a PNG in their order, each as its name and its data. Each one's CRC is held to its name and its data."""
    assert encoded[:8] == SIGNATURE
    found: list[tuple[bytes, bytes]] = []
    at = 8
    while at < len(encoded):
        length = number(encoded[at : at + 4])
        name, data = encoded[at + 4 : at + 8], encoded[at + 8 : at + 8 + length]
        assert len(data) == length
        assert number(encoded[at + 8 + length : at + 12 + length]) == zlib.crc32(name + data)
        found.append((name, data))
        at += 12 + length
    return found


def test_a_png_is_a_header_the_rows_deflated_and_an_end() -> None:
    pixels = Pixels(width=3, height=2, rgb=bytes(range(18)))
    [(first, header), (second, deflated), (third, end)] = chunks(png(pixels))
    assert (first, second, third) == (b"IHDR", b"IDAT", b"IEND")
    # The width, the height, eight bits for a sample, the colour type of red, green and blue, and nothing interlaced.
    assert (number(header[:4]), number(header[4:8]), header[8:]) == (3, 2, bytes([8, 2, 0, 0, 0]))
    # Each row is its pixels, after a byte that says they are written as they are.
    assert zlib.decompress(deflated) == bytes([0, *range(9), 0, *range(9, 18)])
    assert end == b""


def test_an_image_of_one_pixel_is_one_row_of_three_bytes() -> None:
    [_, (_, deflated), _] = chunks(png(Pixels(width=1, height=1, rgb=bytes([7, 8, 9]))))
    assert zlib.decompress(deflated) == bytes([0, 7, 8, 9])


@pytest.mark.parametrize("given", [0, 11, 13])
def test_pixels_that_are_not_three_bytes_for_each_pixel_are_refused(given: int) -> None:
    with pytest.raises(ValueError, match=f"is 12 bytes, and {given} were given"):
        png(Pixels(width=2, height=2, rgb=bytes(given)))
