"""Normalize HPC's source paths for repository-scoped Codecov components."""

import json
from pathlib import Path
import sys


report = Path(sys.argv[1]).resolve()
root = Path(__file__).resolve().parents[2]
data = json.loads(report.read_text())
if not data["coverage"]:
    raise AssertionError("HPC reported no source files")
normalized = {}
for filename, counts in data["coverage"].items():
    source = (report.parent / filename).resolve()
    if not source.is_file():
        raise AssertionError(f"HPC named a missing source file: {source}")
    normalized[str(source.relative_to(root))] = counts
data["coverage"] = normalized
report.write_text(json.dumps(data, sort_keys=True) + "\n")
