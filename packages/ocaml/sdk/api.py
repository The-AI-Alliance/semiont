"""Generate or verify the installed compiler interface and its complete source inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent


def source_inputs(recipe):
    files = {root / file for file in recipe['files']}
    if any(path.is_symlink() for path in files):
        raise RuntimeError('API input files must be inside the source package')
    for directory in recipe['directories']:
        source = root / directory
        if not source.is_dir() or source.is_symlink():
            raise RuntimeError(f'API input directory is missing or linked: {directory}')
        for path in source.rglob('*'):
            if path.is_symlink():
                raise RuntimeError(f'API input is a symlink: {path}')
            if path.is_file():
                files.add(path)
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(files)
    }


def installed_api(recipe):
    subprocess.run(['dune', 'build', '@install', 'probes/api_inventory.exe'], cwd=root, check=True)
    installed = root / '_build/install/default/lib/semiont'
    public_units = sorted(path for path in installed.rglob('*.cmi')
                          if '.private' not in path.relative_to(installed).parts
                          and '__' not in path.stem)
    actual_roots = sorted(str(path.relative_to(installed).with_suffix('')) for path in public_units)
    if actual_roots != recipe['roots']:
        raise RuntimeError(f'Installed public roots differ: {actual_roots}')
    inventories = []
    for path in public_units:
        result = subprocess.run(
            [str(root / '_build/default/probes/api_inventory.exe'), str(path), str(installed)],
            cwd=root, text=True, capture_output=True, check=True)
        inventories.append(json.loads(result.stdout))
    compilers = {inventory['compiler'] for inventory in inventories}
    if len(compilers) != 1:
        raise RuntimeError('Installed interfaces did not use one compiler')
    return {
        'compiler': compilers.pop(),
        'inputs': source_inputs(recipe),
        'entries': [entry for inventory in inventories for entry in inventory['entries']],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--write', action='store_true')
    options = parser.parse_args()
    recipe = json.loads((root / 'public-api.inputs.json').read_text())
    actual = installed_api(recipe)
    output = root / 'public-api.json'
    if options.write:
        output.write_text(json.dumps(actual, indent=2) + '\n')
    else:
        if json.loads(output.read_text()) != actual:
            raise SystemExit('OCaml public API snapshot differs; run python3 api.py --write in the OCaml container')
        print(f'OCaml installed public API verified: {len(actual["entries"])} entries')


if __name__ == '__main__':
    main()
