from PIL import Image, ImageDraw, ImageFont
import zlib, base64, textwrap

TEXT = ["RECOVERED FROM", "THE PIXELS"]
W, H = 1600, 560
img = Image.new("L", (W, H), 255)
d = ImageDraw.Draw(img)
font = None
for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
          "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
    try:
        font = ImageFont.truetype(p, 110); break
    except Exception: pass
if font is None: raise SystemExit("no truetype font available")
y = 70
for line in TEXT:
    d.text((80, y), line, fill=0, font=font); y += 200

raw = img.tobytes()                       # RGB, 8bpc
comp = zlib.compress(raw, 9)

def obj(n, body): return f"{n} 0 obj\n{body}\nendobj\n".encode("latin-1")

# Minimal one-page PDF: image XObject drawn full-page, NO text operators.
img_obj = (f"<< /Type /XObject /Subtype /Image /BitsPerComponent 8 /Width {W} /Height {H} "
           f"/ColorSpace /DeviceGray /Filter /FlateDecode /Length {len(comp)} >>\nstream\n").encode("latin-1")
img_obj += comp + b"\nendstream"

content = f"q 552 0 0 193 30 480 cm /Im0 Do Q".encode("latin-1")
parts, offsets, buf = [], {}, b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"
def add(n, body_bytes):
    global buf
    offsets[n] = len(buf)
    buf += f"{n} 0 obj\n".encode("latin-1") + body_bytes + b"\nendobj\n"

add(1, b"<< /Type /Catalog /Pages 2 0 R >>")
add(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
add(3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>")
add(4, img_obj)
add(5, f"<< /Length {len(content)} >>\nstream\n".encode("latin-1") + content + b"\nendstream")

xref_at = len(buf)
buf += f"xref\n0 6\n0000000000 65535 f \n".encode("latin-1")
for n in range(1, 6):
    buf += f"{offsets[n]:010d} 00000 n \n".encode("latin-1")
buf += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n".encode("latin-1")

open("/out/legible-scan.pdf", "wb").write(buf)
print("bytes:", len(buf))
