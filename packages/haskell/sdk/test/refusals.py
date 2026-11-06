"""Compile real external consumers, including invalid programs, with the pinned GHC."""

import subprocess
import tempfile
import re
from pathlib import Path


with tempfile.TemporaryDirectory() as output:
    command = [
        "cabal", "exec", "--", "ghc", "-fno-code", "-package", "semiont",
        "-XGHC2021", "-Wall", "-Werror", "-outputdir", output,
    ]
    subprocess.run(command + ["test/refusals/Valid.hs"], check=True, timeout=30)
    expected = {
        "WrongPayload": "GHC-83865",
        "MissingScope": "GHC-83865",
        "UncheckedIdentifier": "GHC-01928",
        "CoercedIdentifier": "constructor",
        "CrossIdentifier": "GHC-83865",
        "RecordIdentifier": "GHC-22385",
        "IncompleteErrorCode": "non-exhaustive",
        "BusWrongPayload": "GHC-83865",
        "BusMissingScope": "GHC-83865",
        "WritableState": "does not export",
        "TransportInputCoercion": "constructor",
        "HttpPoolCoercion": "constructor",
        "WrongHttpAnswer": "GHC-83865",
        "WorkerWrongResult": "GHC-83865",
        "ClientRecordUpdate": "GHC-22385",
    }
    actual = {path.stem for path in Path("test/refusals").glob("*.hs")}
    if actual != set(expected) | {"Valid"}:
        raise AssertionError(f"external compiler cases differ from their runner: {actual ^ (set(expected) | {'Valid'})}")
    for name, diagnostic in expected.items():
        result = subprocess.run(
            command + [f"test/refusals/{name}.hs"], text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30,
        )
        if result.returncode == 0 or diagnostic not in result.stdout:
            raise AssertionError(f"{name}: wrong compilation result\n{result.stdout}")
        print(f"PASS SDK external compile refusal: {name}", flush=True)
    examples = re.findall(r"```haskell\n(.*?)\n```", Path("README.md").read_text(), re.DOTALL)
    if not examples:
        raise AssertionError("SDK README declares no Haskell examples")
    for index, source in enumerate(examples):
        path = Path(output) / f"ReadmeExample{index}.hs"
        path.write_text(source + "\n")
        subprocess.run(command + [str(path)], check=True, timeout=30)
        print(f"PASS SDK README example {index + 1}", flush=True)
