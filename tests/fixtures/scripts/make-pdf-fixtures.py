#!/usr/bin/env python3
"""Write the PDF fixtures of the Smelter's extraction cases into specs/src/smelter/fixtures/.

    python3 tests/fixtures/scripts/make-pdf-fixtures.py

Each fixture is written object by object with the standard library alone, and is the same bytes on every run and on
every machine: no date, no random identifier, and no compression but the deflate written here, so that no build of
zlib decides a byte. specs/src/smelter/extraction-cases.json states what a reader must find in each. Text is drawn in
Helvetica, a standard font that needs no font file, and every page is US Letter (612 by 792 points).

    single-line.pdf     one line of text on one page
    multi-line.pdf      three lines on one page, each drawn at a place of its own
    multi-page.pdf      two pages, with a line on each
    multi-column.pdf    two columns of two lines each: prose, and no grid
    table.pdf           four rows of three cells at three column origins: a grid
    form.pdf            a drawn title and a form of four fields under `policy`: three have a value and `notes` has none
    mixed.pdf           a page of text, then a page that is one image of bars
    scanned.pdf         one empty page: no text and no image
    scanned-image.pdf   a page that is one image of dark bars, which has no character in it
    scanned-jpeg.pdf    a page that is one small grey JPEG image (`/DCTDecode`)
    scanned-placed.pdf  the image of bars drawn smaller and away from the page's corner, by the matrix [300 0 0 400 100 200]
    shared-image.pdf    two pages that paint one image object
    encrypted.pdf       a page of text behind the standard security handler (RC4, 40 bits): it asks for a password

legible-scan.pdf, in the same directory, is not made here: its pixels are words, and words need a typeface.
tests/fixtures/scripts/make-legible-scan.py makes it.
"""

from __future__ import annotations

import hashlib
import struct
import zlib
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Final

__all__ = ["fixtures"]

_DIRECTORY: Final = Path(__file__).resolve().parents[3] / "specs" / "src" / "smelter" / "fixtures"

# ── A document ───────────────────────────────────────────────────────────────


class _Document:
    """The objects of one PDF, numbered from 1 as they are added. 1 is the catalog and 2 the page tree, written last."""

    def __init__(self) -> None:
        self._bodies: list[bytes | None] = [None, None]
        self._pages: list[int] = []
        self._font: int | None = None

    def reserve(self) -> int:
        """The number of an object that is put later, for the objects that name it before it can be written."""
        self._bodies.append(None)
        return len(self._bodies)

    def put(self, number: int, body: str | bytes) -> None:
        self._bodies[number - 1] = body if isinstance(body, bytes) else body.encode("ascii")

    def add(self, body: str | bytes) -> int:
        number = self.reserve()
        self.put(number, body)
        return number

    def font(self) -> int:
        """Helvetica: one object, however many pages draw with it."""
        if self._font is None:
            self._font = self.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
        return self._font

    def page(self, number: int, resources: str = "", contents: int | None = None, more: str = "") -> None:
        """The next page of the document, as the object of this number. A page with no contents is empty."""
        drawn = "" if contents is None else f" /Contents {contents} 0 R"
        self.put(number, f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << {resources} >>{drawn}{more} >>")
        self._pages.append(number)

    def text_page(self, drawn: str) -> None:
        """A page of text, and nothing else."""
        font = self.font()
        number = self.reserve()
        self.page(number, f"/Font << /F1 {font} 0 R >>", self.add(_stream(drawn.encode("ascii"))))

    def image_page(self, image: int, x: float, y: float, width: float, height: float) -> None:
        """A page that paints one image and draws no text: the image fills the box given, whose least corner is (x, y)."""
        painted = f"q {width:g} 0 0 {height:g} {x:g} {y:g} cm /Im1 Do Q"
        number = self.reserve()
        self.page(number, f"/XObject << /Im1 {image} 0 R >>", self.add(_stream(painted.encode("ascii"))))

    def written(self, catalog: str = "", trailer: str = "") -> bytes:
        """The file: every object, then the table of the byte each begins at."""
        kids = _references(self._pages)
        self.put(1, f"<< /Type /Catalog /Pages 2 0 R{catalog} >>")
        self.put(2, f"<< /Type /Pages /Kids [{kids}] /Count {len(self._pages)} >>")
        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets: list[int] = []
        for at, body in enumerate(self._bodies):
            if body is None:
                raise ValueError(f"object {at + 1} was reserved and never put")
            offsets.append(len(out))
            out += f"{at + 1} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
        table = len(out)
        size = len(self._bodies) + 1
        out += f"xref\n0 {size}\n0000000000 65535 f \n".encode("ascii")
        for offset in offsets:
            out += f"{offset:010d} 00000 n \n".encode("ascii")
        out += f"trailer\n<< /Size {size} /Root 1 0 R{trailer} >>\nstartxref\n{table}\n%%EOF\n".encode("ascii")
        return bytes(out)


def _references(numbers: Sequence[int]) -> str:
    return " ".join(f"{number} 0 R" for number in numbers)


def _stream(data: bytes, entries: str = "") -> bytes:
    """A stream object's body: its dictionary, with these entries before its length, and its bytes."""
    return f"<< {entries}/Length {len(data)} >>\nstream\n".encode("ascii") + data + b"\nendstream"


# ── Text ─────────────────────────────────────────────────────────────────────


def _literal(text: str) -> str:
    """The text as the inside of a literal string."""
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _text(lines: Sequence[str], x: float, y: float, size: float = 12, leading: float = 0) -> str:
    """Lines of text: each is shown by a `Tj` of its own, the first with its baseline's left end at (x, y) and each next one lower."""
    drawn = ["BT", f"/F1 {size:g} Tf"]
    for at, line in enumerate(lines):
        drawn += [f"1 0 0 1 {x:g} {y - at * leading:g} Tm", f"({_literal(line)}) Tj"]
    return "\n".join([*drawn, "ET"])


# ── Images ───────────────────────────────────────────────────────────────────


class _Bits:
    """Bits packed into bytes as deflate packs them: the first bit written is a byte's least significant."""

    def __init__(self) -> None:
        self._bytes = bytearray()
        self._held = 0
        self._count = 0

    def number(self, value: int, width: int) -> None:
        """A number, its least significant bit first."""
        self._held |= value << self._count
        self._count += width
        while self._count >= 8:
            self._bytes.append(self._held & 0xFF)
            self._held >>= 8
            self._count -= 8

    def code(self, value: int, width: int) -> None:
        """A Huffman code, its most significant bit first."""
        self.number(int(format(value, f"0{width}b")[::-1], 2), width)

    def symbol(self, symbol: int) -> None:
        """A literal byte (0 to 255), the end of the block (256) or a length (257 to 285), in the fixed codes."""
        if symbol < 144:
            self.code(0x30 + symbol, 8)
        elif symbol < 256:
            self.code(0x190 + symbol - 144, 9)
        elif symbol < 280:
            self.code(symbol - 256, 7)
        else:
            self.code(0xC0 + symbol - 280, 8)

    def written(self) -> bytes:
        return bytes(self._bytes) + (bytes([self._held]) if self._count else b"")


# The least length each length symbol stands for, from symbol 257, and how many bits follow it to say how much longer.
_LENGTHS: Final = (3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258)
_LENGTH_BITS: Final = (0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0)


def _deflated(data: bytes) -> bytes:
    """The bytes as a zlib stream (RFC 1950, RFC 1951): one block in the fixed codes, a run of one byte being that byte and copies of it."""
    bits = _Bits()
    bits.number(1, 1)  # the last block
    bits.number(1, 2)  # in the fixed codes
    at = 0
    while at < len(data):
        byte = data[at]
        run = 1
        while at + run < len(data) and data[at + run] == byte:
            run += 1
        at += run
        bits.symbol(byte)
        run -= 1
        while run >= 3:
            length = min(run, 258)
            index = max(index for index, least in enumerate(_LENGTHS) if least <= length)
            bits.symbol(257 + index)
            bits.number(length - _LENGTHS[index], _LENGTH_BITS[index])
            bits.code(0, 5)  # copied from one byte back
            run -= length
        for _ in range(run):
            bits.symbol(byte)
    bits.symbol(256)
    return b"\x78\x9c" + bits.written() + struct.pack(">I", zlib.adler32(data))


def _bars_image(document: _Document) -> int:
    """A crude picture of three lines of text, 240 pixels by 140: dark bars on white, with no character in them."""
    white, dark = b"\xff\xff\xff", b"\x20\x20\x20"
    barred = white * 20 + dark * 200 + white * 20
    rows = [barred if any(top <= y < top + 14 for top in (20, 60, 100)) else white * 240 for y in range(140)]
    described = "/Type /XObject /Subtype /Image /Width 240 /Height 140 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode "
    return document.add(_stream(_deflated(b"".join(rows)), described))


# The smallest baseline JPEG: one block of 8 by 8 grey pixels, all of one grey, with Huffman tables of one code each.
_JPEG: Final = bytes(
    [0xFF, 0xD8]  # start of image
    + [0xFF, 0xDB, 0x00, 0x43, 0x00, *[0x10] * 64]  # quantization table 0, flat
    + [0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01, 0x11, 0x00]  # baseline frame: 8 by 8, one component
    + [0xFF, 0xC4, 0x00, 0x14, 0x00, 0x01, *[0x00] * 15, 0x00]  # DC table 0: one code of one bit, for the value 0
    + [0xFF, 0xC4, 0x00, 0x14, 0x10, 0x01, *[0x00] * 15, 0x00]  # AC table 0: one code of one bit, for the end of a block
    + [0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]  # scan: one component, coefficients 0 to 63
    + [0x3F]  # the block: DC 0, end of block, padding
    + [0xFF, 0xD9]  # end of image
)


def _jpeg_image(document: _Document) -> int:
    described = "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode "
    return document.add(_stream(_JPEG, described))


# ── Encryption: the standard security handler, revision 2 ────────────────────

_USER_PASSWORD: Final = b"reader"
_OWNER_PASSWORD: Final = b"owner"
_PERMISSIONS: Final = -4  # everything is permitted to a reader that has opened the document
_PADDING: Final = bytes.fromhex("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a")


def _padded(password: bytes) -> bytes:
    return (password + _PADDING)[:32]


def _rc4(key: bytes, data: bytes) -> bytes:
    state = list(range(256))
    j = 0
    for i in range(256):
        j = (j + state[i] + key[i % len(key)]) % 256
        state[i], state[j] = state[j], state[i]
    out = bytearray()
    i = j = 0
    for byte in data:
        i = (i + 1) % 256
        j = (j + state[i]) % 256
        state[i], state[j] = state[j], state[i]
        out.append(byte ^ state[(state[i] + state[j]) % 256])
    return bytes(out)


def _object_key(key: bytes, number: int) -> bytes:
    """The key one object's strings and streams are under: the document's key with the object's number and generation (0), hashed."""
    return hashlib.md5(key + number.to_bytes(3, "little") + (0).to_bytes(2, "little")).digest()[: len(key) + 5]


# ── The fixtures ─────────────────────────────────────────────────────────────


def _single_line() -> bytes:
    document = _Document()
    document.text_page(_text(["known phrase from fixture"], 72, 720))
    return document.written()


def _multi_line() -> bytes:
    document = _Document()
    document.text_page(_text(["first line of text", "second line of text", "third line of text"], 72, 720, leading=20))
    return document.written()


def _multi_page() -> bytes:
    document = _Document()
    document.text_page(_text(["content on page one"], 72, 720))
    document.text_page(_text(["content on page two"], 72, 720))
    return document.written()


def _multi_column() -> bytes:
    left = _text(["left column line one", "left column line two"], 72, 720, leading=20)
    right = _text(["right column line one", "right column line two"], 320, 720, leading=20)
    document = _Document()
    document.text_page(f"{left}\n{right}")
    return document.written()


def _table() -> bytes:
    rows = (("Treatment", "Responders", "p-value"), ("Drug A", "12%", "0.03"), ("Drug B", "9%", "0.21"), ("Placebo", "4%", "0.88"))
    columns = (72, 250, 420)
    cells = [_text([cell], x, 720 - 24 * at) for at, row in enumerate(rows) for x, cell in zip(columns, row)]
    document = _Document()
    document.text_page("\n".join(cells))
    return document.written()


def _form() -> bytes:
    # A field's name, its kind, its value if it has one, and the box its widget is drawn in: x, y, width, height.
    fields: Sequence[tuple[str, str, str | None, tuple[float, float, float, float]]] = (
        ("holderName", "/FT /Tx", "Ada Lovelace", (72, 700, 200, 20)),
        ("coverageAmount", "/FT /Tx", "$250,000", (72, 660, 200, 20)),
        ("state", "/FT /Ch /Ff 131072 /Opt [(CA) (NY)]", "NY", (72, 620, 100, 20)),
        ("notes", "/FT /Tx", None, (72, 580, 200, 20)),
    )
    document = _Document()
    font = document.font()
    page = document.reserve()
    policy = document.reserve()
    kids: list[int] = []
    widgets: list[int] = []
    for name, kind, value, (x, y, width, height) in fields:
        field = document.reserve()
        # A widget's rectangle is its box and the half of its border, one point wide, that lies outside the box.
        rectangle = f"{x - 0.5:g} {y - 0.5:g} {x + width + 0.5:g} {y + height + 0.5:g}"
        look = "/F 4 /BS << /W 1 >> /MK << /BC [0 0 0] /BG [1 1 1] >>"
        widget = document.add(f"<< /Type /Annot /Subtype /Widget /Rect [{rectangle}] /Parent {field} 0 R /P {page} 0 R {look} >>")
        held = "" if value is None else f" /V ({_literal(value)})"
        document.put(field, f"<< {kind} /T ({name}){held} /Parent {policy} 0 R /Kids [{widget} 0 R] >>")
        kids.append(field)
        widgets.append(widget)
    document.put(policy, f"<< /T (policy) /Kids [{_references(kids)}] >>")
    contents = document.add(_stream(_text(["Policy Application"], 72, 740, size=14).encode("ascii")))
    document.page(page, f"/Font << /F1 {font} 0 R >>", contents, f" /Annots [{_references(widgets)}]")
    # No widget has an appearance stream: a reader is told to make each field's look from its value.
    look = f"/NeedAppearances true /DA (0 0 0 rg /Helvetica 15 Tf) /DR << /Font << /Helvetica {font} 0 R >> >>"
    return document.written(catalog=f" /AcroForm << /Fields [{policy} 0 R] {look} >>")


def _mixed() -> bytes:
    document = _Document()
    document.text_page(_text(["native page text"], 72, 720))
    document.image_page(_bars_image(document), 0, 0, 612, 792)
    return document.written()


def _scanned() -> bytes:
    document = _Document()
    document.page(document.reserve())
    return document.written()


def _scanned_image() -> bytes:
    document = _Document()
    document.image_page(_bars_image(document), 0, 0, 612, 792)
    return document.written()


def _scanned_jpeg() -> bytes:
    document = _Document()
    document.image_page(_jpeg_image(document), 0, 0, 612, 792)
    return document.written()


def _scanned_placed() -> bytes:
    document = _Document()
    document.image_page(_bars_image(document), 100, 200, 300, 400)
    return document.written()


def _shared_image() -> bytes:
    document = _Document()
    image = _bars_image(document)
    document.image_page(image, 0, 0, 612, 792)
    document.image_page(image, 0, 0, 612, 792)
    return document.written()


def _encrypted() -> bytes:
    identifier = hashlib.md5(b"encrypted.pdf").digest()
    owner = _rc4(hashlib.md5(_padded(_OWNER_PASSWORD)).digest()[:5], _padded(_USER_PASSWORD))
    key = hashlib.md5(_padded(_USER_PASSWORD) + owner + struct.pack("<i", _PERMISSIONS) + identifier).digest()[:5]
    user = _rc4(key, _PADDING)
    document = _Document()
    font = document.font()
    contents = document.reserve()
    document.put(contents, _stream(_rc4(_object_key(key, contents), _text(["text behind a password"], 72, 720).encode("ascii"))))
    document.page(document.reserve(), f"/Font << /F1 {font} 0 R >>", contents)
    information = document.reserve()
    document.put(information, f"<< /Title <{_rc4(_object_key(key, information), b'A document that asks for a password').hex()}> >>")
    # Neither this dictionary's strings nor the trailer's identifier are encrypted: a reader needs them to make the key.
    encryption = document.add(f"<< /Filter /Standard /V 1 /R 2 /O <{owner.hex()}> /U <{user.hex()}> /P {_PERMISSIONS} >>")
    stated = f"<{identifier.hex()}>"
    return document.written(trailer=f" /Info {information} 0 R /Encrypt {encryption} 0 R /ID [{stated} {stated}]")


_FIXTURES: Final[dict[str, Callable[[], bytes]]] = {
    "single-line.pdf": _single_line,
    "multi-line.pdf": _multi_line,
    "multi-page.pdf": _multi_page,
    "multi-column.pdf": _multi_column,
    "table.pdf": _table,
    "form.pdf": _form,
    "mixed.pdf": _mixed,
    "scanned.pdf": _scanned,
    "scanned-image.pdf": _scanned_image,
    "scanned-jpeg.pdf": _scanned_jpeg,
    "scanned-placed.pdf": _scanned_placed,
    "shared-image.pdf": _shared_image,
    "encrypted.pdf": _encrypted,
}


def fixtures() -> dict[str, bytes]:
    """Every fixture's bytes, by its file's name. Nothing is written."""
    return {name: make() for name, make in _FIXTURES.items()}


def main() -> None:
    _DIRECTORY.mkdir(parents=True, exist_ok=True)
    for name, content in fixtures().items():
        (_DIRECTORY / name).write_bytes(content)
        print(f"wrote {name}: {len(content)} bytes")


if __name__ == "__main__":
    main()
