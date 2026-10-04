# semiont-codegen (Rust)

[![crates.io](https://img.shields.io/crates/v/semiont-codegen.svg)](https://crates.io/crates/semiont-codegen)
[![docs.rs](https://img.shields.io/docsrs/semiont-codegen)](https://docs.rs/semiont-codegen)
[![CI](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/crates/l/semiont-codegen.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The generator the Rust crates' build scripts share: `specs/src` bundled into
whole documents, and Rust types generated from their component schemas. One
generator, so the SDK's protocol types and a service's own types are never
generated two ways. It knows the shapes the spec uses and refuses any other,
so a new shape fails the build rather than generating something wrong.

The reference for every item is on [docs.rs](https://docs.rs/semiont-codegen).

A build dependency only; no binary links it.

## License

Apache-2.0. See [LICENSE](../../LICENSE).
