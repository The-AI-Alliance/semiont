# Repository code generation

The declarative inputs live in `protocol/specs/`. Executable generation tooling lives here:

- `bus/`: registry validation and bus generation across languages.
- `schemas/`: schema readers and SDK generation.
- `lib/`: shared committed-output and language-source helpers.

Run the root `generate:*` npm commands. Their `:check` variants check committed
outputs without writing. Package builds invoke the TypeScript generators they need.
Spec checks live in `.github/scripts/checks/specs/`.

The root Make targets run the same owner operations with containerized toolchains:

```sh
make generate
make check-generated
make generate-python
make check-generated-python
```

Focused groups are `bus`, `typescript`, `python`, `go`, `stack-go`, `mcp-tools-go`,
`discovery-go`, `encoding-cases`, and `model-catalogue`. Rust generation remains part of
Cargo builds (`make packages PACKAGE_NAMES=rust`). Checks compare committed outputs without
repairing them; the TypeScript generation chain runs in an isolated tree for comparison.
