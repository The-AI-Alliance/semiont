#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
input=$(mktemp -d)
trap 'rm -rf "$input"' EXIT
python3 - "$input/source.tar.gz" <<'PYTHON'
from pathlib import Path
import sys
import tarfile

source = Path('sdk')
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    for file in sorted(source.rglob('*')):
        relative = file.relative_to(source)
        if '_build' in relative.parts or '__pycache__' in relative.parts:
            continue
        if relative.name == 'compile_commands.json' or not file.is_file():
            continue
        archive.add(file, arcname=str(relative), recursive=False)
PYTHON
container run --rm --memory 4g --volume "$input:/input:ro" \
  --workdir / semiont-ocaml-development bash -ec '
    mkdir /package
    cd /package
    tar -xzf /input/source.tar.gz
    dune build @all @opam
    python3 test/check-format.py
    dune runtest
    dune install --pkg=disabled --prefix /installed
    python3 test/check-installed-api.py --installed /installed/lib/semiont
    python3 probes/check-interface.py
    python3 api.py
    python3 probes/check-api-controls.py
    _build/default/probes/api_inventory.exe /installed/lib/semiont/semiont.cmi /installed/lib/semiont > /tmp/installed-interface.json
    python3 -c "import json; x=json.load(open(\"/tmp/installed-interface.json\")); assert x[\"entries\"]; print(\"isolated source package: installed compiler interface is readable\")"
  '
