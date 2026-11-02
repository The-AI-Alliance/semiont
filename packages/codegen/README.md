# Repository code generation

The declarative inputs live in `specs/`. Executable generation tooling lives here:

- `bus/`: registry validation and bus generation across languages.
- `schemas/`: schema readers and SDK generation.
- `lib/`: shared committed-output and language-source helpers.

Run the root `generate:*` npm commands. Their `:check` variants check committed
outputs without writing. Package builds invoke the TypeScript generators they need.
Spec checks live in `.github/scripts/checks/specs/`.
