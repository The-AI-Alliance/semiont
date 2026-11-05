"""Normalize HPC LCOV paths without changing line, function or branch counts."""

from pathlib import Path
import sys


report = Path(sys.argv[1]).resolve()
root = Path(__file__).resolve().parents[2]
lines = report.read_text().splitlines(keepends=True)
files = 0
for index, line in enumerate(lines):
    if not line.startswith("SF:"):
        continue
    source = (report.parent / line[3:].strip()).resolve()
    if not source.is_file():
        raise AssertionError(f"HPC named a missing source file: {source}")
    lines[index] = "SF:" + source.relative_to(root).as_posix() + "\n"
    files += 1
if files == 0:
    raise AssertionError("HPC reported no source files")
report.write_text("".join(lines))
