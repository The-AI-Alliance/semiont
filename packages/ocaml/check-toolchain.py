"""Hold Dune's compiler and repository constraints to the container pins."""
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parent
pins = json.loads((root / 'toolchain.json').read_text())
project = (root / 'sdk/dune-project').read_text()
workspace = (root / 'sdk/dune-workspace').read_text()
assert re.findall(r'\(ocaml \(= ([^)]+)\)\)', project) == [pins['ocaml']]
assert re.findall(r'\(lang dune ([^)]+)\)', project) == ['.'.join(pins['dune'].split('.')[:2])]
assert re.findall(r'git\+https://github.com/ocaml/opam-repository.git#([a-f0-9]+)', workspace) == [pins['opamRepository']]
assert re.findall(r'git\+https://github.com/ocaml-dune/opam-overlays.git#([a-f0-9]+)', workspace) == [pins['duneOverlay']]
print('OCaml toolchain constraints agree')
