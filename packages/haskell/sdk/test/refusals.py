"""Compile real external consumers, including invalid programs, with the pinned GHC."""

import subprocess
import tempfile


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
    }
    for name, diagnostic in expected.items():
        result = subprocess.run(
            command + [f"test/refusals/{name}.hs"], text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30,
        )
        if result.returncode == 0 or diagnostic not in result.stdout:
            raise AssertionError(f"{name}: wrong compilation result\n{result.stdout}")
        print(f"PASS SDK external compile refusal: {name}", flush=True)
