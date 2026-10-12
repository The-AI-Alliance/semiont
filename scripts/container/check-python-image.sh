#!/bin/sh
# check-python-image.sh <service> <image> [runtime] — what the image of a
# Python service promises (the worker's, the weaver's, the smelter's), checked
# against a built image:
#
#   1. No installer and no Node: as its user, nothing on its PATH installs a
#      package (pip, uv) or runs JavaScript (node, npm), and its Python has
#      no pip.
#   2. Every library it can be configured for: every module of the Python
#      packages the image builds from this repository imports there, each
#      inference driver with the library its provider is asked through, and
#      each graph store with the client its database is asked through. A
#      service imports a driver or a store when its configuration names one,
#      so an image missing a library starts all the same, and fails where
#      that provider or that database is configured.
#   3. Run as the image says, with no document mounted where its CMD tells it
#      to read one, it refuses by name: exit 1, naming the document it cannot
#      read.
#   4. The smelter's alone. It has the `tesseract` program, with its English
#      data. And with no network, the Smelter's own reader and engine read a
#      scanned page there: the words that are in the pixels of
#      specs/src/smelter/fixtures/legible-scan.pdf, a document with no text
#      of its own. The reader is PDFium, which comes in a wheel, and the
#      engine is the program. A Smelter loads the one and runs the other
#      once it has read its document, which no check above gives it.
#
# Run by local-build.sh after it builds such an image, and by the image
# publish workflow before it pushes.
set -eu

SERVICE="${1:?usage: check-python-image.sh <service> <image> [runtime]}"
IMAGE="${2:?usage: check-python-image.sh <service> <image> [runtime]}"
RT="${3:-docker}"
REPOSITORY="$(cd "$(dirname "$0")/../.." && pwd)"
DOCKERFILE="$REPOSITORY/apps/$SERVICE/Dockerfile"
COMMAND=$(sed -n 's/^CMD \[\(.*\)\]$/\1/p' "$DOCKERFILE" | sed 's/", "/ /g; s/"//g')
if [ -z "$COMMAND" ]; then
  echo "✗ $DOCKERFILE declares no exec-form CMD"
  exit 1
fi

# The script runs, and expands, inside the container.
# shellcheck disable=SC2016
found=$("$RT" run --rm --entrypoint /bin/sh "$IMAGE" -c '
  for tool in pip pip3 uv uvx node npm npx; do command -v "$tool"; done
  python -c "import importlib.util, sys; sys.exit(importlib.util.find_spec(\"pip\") is not None)" || echo "pip, as a module of its Python"
  true')
if [ -n "$found" ]; then
  echo "✗ $IMAGE carries an installer or Node:"
  echo "$found"
  exit 1
fi
echo "✓ $IMAGE carries no installer and no Node"

# The packages built from this repository are the ones installed from a
# directory, which each one's own record says. A module named __main__ is a
# program, which importing would run: the refusal below runs the service's.
WALK='
import importlib
import importlib.metadata
import json
import pkgutil
import sys

built_here = set()
for distribution in importlib.metadata.distributions():
    origin = distribution.read_text("direct_url.json")
    if origin is not None and "dir_info" in json.loads(origin):
        built_here.add(distribution.metadata["Name"])
packages = sorted(name for name, owners in importlib.metadata.packages_distributions().items() if built_here & set(owners))
if not packages:
    sys.exit("no package in the image was installed from a directory: the check has lost what it reads")

modules = 0
failed = []
for package in packages:
    names = [package] + [module.name for module in pkgutil.walk_packages(importlib.import_module(package).__path__, package + ".")]
    for name in names:
        if name.rsplit(".", 1)[-1] == "__main__":
            continue
        modules += 1
        try:
            importlib.import_module(name)
        except Exception as error:
            failed.append(f"{name}: {type(error).__name__}: {error}")
if failed:
    sys.exit("\n".join(failed))
print(f"{modules} modules of {len(packages)} packages:", ", ".join(packages))
'
# The image's own shell finds `python`, as it does for the image's command.
# shellcheck disable=SC2016
if ! imported=$("$RT" run --rm --entrypoint /bin/sh -e WALK="$WALK" "$IMAGE" -c 'python -c "$WALK"' 2>&1); then
  echo "✗ $IMAGE does not import every module of the packages built into it:"
  echo "$imported"
  exit 1
fi
echo "✓ $IMAGE imports every module of the packages built into it, each with the library it asks through: $imported"

# The script runs, and expands, inside the container: the command's output,
# then a last line of its exit status.
# shellcheck disable=SC2016
out=$("$RT" run --rm --entrypoint /bin/sh -e COMMAND="$COMMAND" "$IMAGE" -c '
  # shellcheck disable=SC2086
  /usr/local/bin/boot.sh $COMMAND 2>&1
  printf "\n%d" "$?"')
log=$(echo "$out" | sed '$d')
status=$(echo "$out" | tail -1)
if [ "$status" != 1 ]; then
  echo "✗ $IMAGE with no document exited $status, not 1:"
  echo "$log"
  exit 1
fi
if ! echo "$log" | grep -qF "Cannot read the $SERVICE's configuration document"; then
  echo "✗ $IMAGE with no document did not refuse by name:"
  echo "$log"
  exit 1
fi
echo "✓ $IMAGE with no document refuses by name: $(echo "$log" | head -1)"

# What follows is promised of the smelter's image alone.
if [ "$SERVICE" != smelter ]; then
  exit 0
fi

# The program names the directory of its data, and then each language it has
# data for, on a line of its own.
if ! listed=$("$RT" run --rm --entrypoint /bin/sh "$IMAGE" -c 'tesseract --list-langs' 2>&1); then
  echo "✗ $IMAGE has no tesseract program that lists its data:"
  echo "$listed"
  exit 1
fi
if ! echo "$listed" | grep -qx eng; then
  echo "✗ $IMAGE has the tesseract program, and no English data for it:"
  echo "$listed"
  exit 1
fi
echo "✓ $IMAGE has the tesseract program with its English data: $(echo "$listed" | head -1)"

# A PDF derived as the Smelter derives one, by its reader and its engine, as
# apps/smelter/tests/test_extraction_cases.py derives the same document. The
# page is a picture of the words and has no text of its own, so a word in
# what is derived is one the program read. What is printed is the stamp the
# Smelter writes its anchored text under: the reader's version and the
# engine's, with its data.
READ='
import asyncio
import sys
from pathlib import Path

from semiont.types import ExtractedText
from semiont_smelter.extraction import PdfExtractor
from semiont_smelter.pdfium import PdfiumReader
from semiont_smelter.stamp import current_stamp
from semiont_smelter.tesseract import TesseractEngine

WORDS = ("RECOVERED", "FROM", "THE", "PIXELS")
SECONDS = 120


async def read(scan):
    reader, engine = PdfiumReader(), TesseractEngine()
    async with asyncio.timeout(SECONDS):
        outcome = await PdfExtractor(reader=reader, engine=engine).extract(scan)
        stamp = await current_stamp(reader, engine)
    if not isinstance(outcome, ExtractedText):
        sys.exit(f"the scan was declined: {outcome.declined}")
    unread = [word for word in WORDS if word not in outcome.text]
    if unread:
        sys.exit(f"the engine did not read {unread}: it read {outcome.text!r}")
    return stamp


print(asyncio.run(read(Path(sys.argv[1]).read_bytes())))
'
# The container has no network, and the fixtures as the repository holds them.
# The script runs, and expands, inside the container.
# shellcheck disable=SC2016
if ! stamp=$("$RT" run --rm --network none --entrypoint /bin/sh -e READ="$READ" \
  -v "$REPOSITORY/specs/src/smelter/fixtures:/fixtures:ro" \
  "$IMAGE" -c 'python -c "$READ" /fixtures/legible-scan.pdf' 2>&1); then
  echo "✗ $IMAGE does not read a scanned page with no network:"
  echo "$stamp"
  exit 1
fi
echo "✓ $IMAGE reads a scanned page with no network: $stamp"
