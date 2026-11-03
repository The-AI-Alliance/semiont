"""Prove each public generation group rejects drift, does not repair it, and can regenerate it."""

import subprocess

from operations import GROUPS, ROOT

# Generation restoring these bytes gates this representative-output inventory to its owner.
OUTPUTS = {
    "bus": "packages/typescript/core/src/bus-protocol.ts",
    "typescript": "packages/typescript/core/src/bus-protocol.ts",
    "python": "packages/python/sdk/src/semiont/types.py",
    "go": "packages/go/sdk/api/client_gen.go",
    "stack-go": "packages/go/launcher/stack/types_gen.go",
    "mcp-tools-go": "packages/go/launcher/verbs/mcp_tools_gen.go",
    "discovery-go": "packages/go/launcher/discovery_types_gen.go",
    "encoding-cases": "specs/src/text/encoding-cases.json",
    "model-catalogue": "packages/python/inference/tests/catalogue/model-catalogue.json",
}


def verify() -> None:
    if set(OUTPUTS) != set(GROUPS):
        raise RuntimeError(
            "Every public generation group needs a drift/regeneration case"
        )
    original = {name: (ROOT / name).read_bytes() for name in set(OUTPUTS.values())}
    try:
        for group in GROUPS:
            output = ROOT / OUTPUTS[group]
            before = original[OUTPUTS[group]]
            subprocess.run(["make", "check-generated-" + group], cwd=ROOT, check=True)
            stale = before + b"\n\n"
            output.write_bytes(stale)
            try:
                subprocess.run(
                    ["make", "check-generated-" + group], cwd=ROOT, check=True
                )
            except (RuntimeError, subprocess.CalledProcessError):
                pass
            else:
                raise RuntimeError(f"{group}: check accepted deliberately stale output")
            if output.read_bytes() != stale:
                raise RuntimeError(f"{group}: check repaired the checkout")
            subprocess.run(["make", "generate-" + group], cwd=ROOT, check=True)
            if output.read_bytes() != before:
                raise RuntimeError(
                    f"{group}: generation did not restore its owned output"
                )
            subprocess.run(["make", "check-generated-" + group], cwd=ROOT, check=True)
            print(
                f"PASS {group}: rejects drift, preserves stale bytes, regenerates, then passes",
                flush=True,
            )
    finally:
        for name, contents in original.items():
            (ROOT / name).write_bytes(contents)


if __name__ == "__main__":
    verify()
