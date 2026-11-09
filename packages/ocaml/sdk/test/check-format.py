"""Check every OCaml source file, including interfaces and candidate probes."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
files = sorted(str(path.relative_to(root)) for path in root.rglob('*')
               if path.suffix in ('.ml', '.mli') and '_build' not in path.relative_to(root).parts)
if not files:
    raise SystemExit('No OCaml sources found')
subprocess.run(['dune', 'exec', '--', 'ocamlformat', '--check', *files], cwd=root, check=True)
