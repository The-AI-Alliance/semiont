# semiont-codegen

[![crates.io](https://img.shields.io/crates/v/semiont-codegen.svg)](https://crates.io/crates/semiont-codegen)
[![docs.rs](https://img.shields.io/docsrs/semiont-codegen)](https://docs.rs/semiont-codegen)
[![CI](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/The-AI-Alliance/semiont/actions/workflows/ci.yml?query=branch%3Amain)
[![License](https://img.shields.io/crates/l/semiont-codegen.svg)](https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE)

The build-time code generator of the [Semiont Rust SDK](../sdk-rust/README.md).
It turns the [Semiont specification](../../specs/README.md), an OpenAPI
document and its JSON Schemas, into the Rust types of `semiont::types`.

## You do not need to add it

[`semiont`](https://crates.io/crates/semiont) names this crate as a build
dependency, so Cargo fetches and builds it when it builds the SDK. It runs
in the SDK's build script and is linked into no program. It is published
because a published crate's build dependencies have to be.

To use Semiont from Rust, add `semiont` and
[`semiont-http-transport`](../http-transport-rust/README.md).

## What it does

| Module | |
|---|---|
| `bundle` | `Bundle::of(root_file)` reads a spec document and follows every file `$ref`, giving one whole document. `draft7_definitions` gives its component schemas as JSON Schema draft 7. |
| `types` | `generate(definitions, &generation)` gives the Rust source of the types: a struct per object, an enum per string enumeration, an untagged enum per `oneOf` or `anyOf` (decoded as the member its discriminating property names, when the schema names one), and a type of its own per kind of id, made only by a constructor that holds a value to the schema's pattern. |

It is not a general OpenAPI generator. It knows the shapes Semiont's schemas
use and refuses any other, so a schema that grows a new shape fails the
build rather than generating something wrong. Every function panics with
the reason: a build script has nothing better to do with a spec it cannot
read.

Two build scripts use it, and each is a worked example:
[the SDK's](../sdk-rust/build.rs), for the protocol's types, and
[the services' shared crate's](../core-rust/build.rs), for the types only a
service needs. One generator, so the two are never generated two ways.

Every item is documented on [docs.rs](https://docs.rs/semiont-codegen).

## License

Apache-2.0. See [LICENSE](../../LICENSE).
