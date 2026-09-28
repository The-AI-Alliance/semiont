# The Semiont gateway, in Rust

The gateway the TypeScript one in `apps/gateway` is being replaced by. It
serves what `specs/` declares — the OpenAPI document, the bus registry, the
limits, the environment, the principals and the telemetry tables — and is
judged by `tests/gateway-conformance`, the same black-box suite the TypeScript
gateway passes.

It lives here while the two exist side by side; the cutover moves it to
`apps/gateway` and deletes the TypeScript gateway.

## Building and testing

The toolchain is `rust-toolchain.toml`'s. Everything runs in its image:

```bash
TC=$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)
container run --rm -v "$PWD/../..":/work -w /work/apps/gateway-rs "rust:$TC-alpine" \
  sh -c 'cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test && cargo build --release'
```

`cargo test` runs the only Rust tests there are: the runners for the shared
case tables (`tests/tables.rs`). Everything else is the conformance suite's:

```bash
cd ../../tests/gateway-conformance
npm ci
npm run test:rust
```

## What is built in

`build.rs` bundles `specs/src` into the gateway's and the Archivist's OpenAPI
documents and compiles every component schema, so a malformed spec fails the
build; the binary embeds them, the bus registry, and
`src/bus-classification.json`, which `scripts/bus/generate-ts.mjs` writes. Its
version is `version.json`'s.
