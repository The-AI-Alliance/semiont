"""Pixels as a PNG, for an engine that takes an encoded image.

No image library is used. The file is the least a PNG can be: its
signature, a header, the rows deflated as one stream, and the end mark. It
is the same bytes for the same pixels, every time.

A PNG is a signature and then chunks. Each chunk is its data's length, a
name of four letters, the data, and a CRC-32 of the name and the data;
numbers are four bytes, the largest first. The header (`IHDR`) states the
width, the height, eight bits for each sample, the colour type 2 (red,
green, blue), and that nothing is interlaced. The pixels (`IDAT`) are a
zlib stream of the rows from the top, each row after one byte that names
its filter, which is 0 here: the row as it is.
"""

import struct
import zlib
from typing import Final

from semiont_smelter.pdf_reader import Pixels

_SIGNATURE: Final = b"\x89PNG\r\n\x1a\n"


def _chunk(name: bytes, data: bytes) -> bytes:
    """One chunk: its data's length, its name, the data, and the CRC-32 of the name and the data."""
    return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))


def png(pixels: Pixels) -> bytes:
    """`pixels` as a PNG of eight bits for each of red, green and blue.

    Raises `ValueError` for pixels that are not three bytes for each pixel
    of their width and height.
    """
    across = pixels.width * 3
    wanted = across * pixels.height
    if len(pixels.rgb) != wanted:
        raise ValueError(f"an image of {pixels.width} by {pixels.height} pixels is {wanted} bytes, and {len(pixels.rgb)} were given")
    rows = b"".join(b"\x00" + pixels.rgb[row * across : (row + 1) * across] for row in range(pixels.height))
    header = struct.pack(">IIBBBBB", pixels.width, pixels.height, 8, 2, 0, 0, 0)
    return _SIGNATURE + _chunk(b"IHDR", header) + _chunk(b"IDAT", zlib.compress(rows, 9)) + _chunk(b"IEND", b"")
