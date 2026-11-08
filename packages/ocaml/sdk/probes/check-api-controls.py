"""Prove that the installed API gate rejects stale inputs and altered snapshots."""
from pathlib import Path
import json
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
snapshot = root / 'public-api.json'
original = snapshot.read_bytes()
source = root / 'lib/semiont.mli'
original_source = source.read_bytes()
extra = root / 'lib/api-freshness-probe.txt'
if extra.exists():
    raise SystemExit('Freshness probe would overwrite an existing file')


def rejects(label):
    before = snapshot.read_bytes()
    result = subprocess.run([sys.executable, 'api.py'], cwd=root, text=True, capture_output=True)
    if result.returncode == 0 or 'snapshot differs' not in result.stderr:
        raise RuntimeError(f'{label}: unexpected gate result: {result.stdout}\n{result.stderr}')
    if snapshot.read_bytes() != before:
        raise RuntimeError(f'{label}: check repaired the snapshot')
    print(f'API gate rejects {label} without repair')


try:
    source.write_bytes(original_source + b'\n')
    rejects('changed source input')
    source.write_bytes(original_source)
    extra.write_text('deliberate extra input\n')
    rejects('new source input')
    extra.unlink()
    for label in ('missing export', 'extra export', 'changed declaration'):
        changed = json.loads(original)
        if label == 'missing export':
            changed['entries'].pop()
        elif label == 'extra export':
            changed['entries'].append({'kind': 'value', 'path': 'Semiont.surprise', 'declaration': 'val surprise : int'})
        else:
            changed['entries'][0]['declaration'] = 'changed'
        snapshot.write_text(json.dumps(changed, indent=2) + '\n')
        rejects(label)
finally:
    source.write_bytes(original_source)
    snapshot.write_bytes(original)
    if extra.exists():
        extra.unlink()

subprocess.run([sys.executable, 'api.py'], cwd=root, check=True)
