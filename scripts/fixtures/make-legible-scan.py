#!/usr/bin/env python3
"""Regenerate the LEGIBLE_SCAN_PDF_FIXTURE_BASE64 constant in tests/e2e/scripts/seed.ts.

Emits a single-page PDF whose only content is a grayscale RASTER of real text
drawn from a real typeface — no text operators at all, so `getTextContent()` is
empty and the sole way to read it is OCR. That is what makes it a scan, and why
`23-pdf-anchored-text.spec.ts` can assert on a map the Smelter genuinely
produced instead of one a test injected.

It is deliberately NOT the fixture `22-pdf-scanned-decline.spec.ts` uses: that
one is unreadable bars, so extraction declines. Two scans, two checksums, two
opposite jobs.

Run it in a container that has Pillow and DejaVu (the host has neither):

    container run --rm -v "$PWD":/out -w /out python:3.12-slim sh -c \
      'pip install --quiet pillow && apt-get update -qq && \
       apt-get install -y -qq fonts-dejavu-core && \
       python make-legible-scan.py /out/legible-scan.pdf'

Then base64 the result into seed.ts. Measured against the live Smelter: 95.8%
mean OCR confidence, 0 low-confidence words, text "RECOVERED FROM\nTHE PIXELS".
"""

import sys
import zlib

from PIL import Image, ImageDraw, ImageFont

# The words the spec quotes. Two short, high-contrast, unambiguous lines —
# chosen so OCR reads them at high confidence rather than to look realistic.
TEXT = ("RECOVERED FROM", "THE PIXELS")

# Raster size, and the box it is drawn into on the page. The raster is wider
# than the text needs: glyphs clipped at the canvas edge cost a letter, and the
# first attempt lost the M in "FROM" that way.
RASTER_W, RASTER_H = 1600, 560
FONT_SIZE, MARGIN_X, FIRST_BASELINE, LINE_STEP = 110, 80, 70, 200

# Page box (US Letter) and the image placement, aspect ratio preserved so the
# glyphs are not squashed — OCR reads distorted text markedly worse.
PAGE_W, PAGE_H = 612, 792
IMG_W, IMG_H, IMG_X, IMG_Y = 552, 193, 30, 480

FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def load_font() -> ImageFont.FreeTypeFont:
    """First available DejaVu face. Bold preferred — heavier strokes OCR better."""
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, FONT_SIZE)
        except OSError:
            # Absent or unreadable face: try the next candidate. Only a missing
            # font is tolerated here, which is why this catches OSError rather
            # than everything — a corrupt Pillow install should still raise.
            continue
    raise SystemExit(
        "no DejaVu truetype face found; install fonts-dejavu-core "
        "(see the module docstring)"
    )


def render_raster() -> bytes:
    """The text as an 8-bit grayscale bitmap. Grayscale halves the fixture with
    no measured change to OCR output."""
    img = Image.new("L", (RASTER_W, RASTER_H), 255)
    draw = ImageDraw.Draw(img)
    font = load_font()
    y = FIRST_BASELINE
    for line in TEXT:
        draw.text((MARGIN_X, y), line, fill=0, font=font)
        y += LINE_STEP
    return img.tobytes()


def build_pdf(raster: bytes) -> bytes:
    """A minimal PDF: catalog, pages, one page, the image, one content stream.

    Hand-assembled rather than pulled from a PDF library so the fixture has no
    build-time dependency beyond Pillow, and so every byte is accounted for.
    """
    compressed = zlib.compress(raster, 9)

    image_obj = (
        f"<< /Type /XObject /Subtype /Image /BitsPerComponent 8 "
        f"/Width {RASTER_W} /Height {RASTER_H} /ColorSpace /DeviceGray "
        f"/Filter /FlateDecode /Length {len(compressed)} >>\nstream\n"
    ).encode("latin-1") + compressed + b"\nendstream"

    content = f"q {IMG_W} 0 0 {IMG_H} {IMG_X} {IMG_Y} cm /Im0 Do Q".encode("latin-1")

    bodies = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>"
        ).encode("latin-1"),
        4: image_obj,
        5: (
            f"<< /Length {len(content)} >>\nstream\n".encode("latin-1")
            + content
            + b"\nendstream"
        ),
    }

    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for num, body in bodies.items():
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode("latin-1") + body + b"\nendobj\n"

    xref_at = len(out)
    out += b"xref\n0 6\n0000000000 65535 f \n"
    for num in sorted(bodies):
        out += f"{offsets[num]:010d} 00000 n \n".encode("latin-1")
    out += (
        f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"
    ).encode("latin-1")
    return bytes(out)


def main() -> None:
    dest = sys.argv[1] if len(sys.argv) > 1 else "legible-scan.pdf"
    pdf = build_pdf(render_raster())
    with open(dest, "wb") as handle:
        handle.write(pdf)
    print(f"wrote {dest}: {len(pdf)} bytes")


if __name__ == "__main__":
    main()
