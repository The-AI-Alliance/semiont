# Rust

The first four are how a Rust program uses Semiont. The last three are what the Rust services share, and are built into their binaries. A service's own crates are beside its binary in [images/](../../images/README.md).

| Crate | Published | Coverage | What it is |
|---|---|---|---|
| [semiont](./sdk/README.md) | [![crates.io](https://img.shields.io/crates/v/semiont.svg)](https://crates.io/crates/semiont) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=rust-sdk)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=rust-sdk) | The Rust SDK: the client of a knowledge base, the protocol's types, sessions and state units |
| [semiont-http-transport](./http-transport/README.md) | [![crates.io](https://img.shields.io/crates/v/semiont-http-transport.svg)](https://crates.io/crates/semiont-http-transport) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=rust-http-transport)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=rust-http-transport) | The SDK's transport over a gateway, and signing a person or a service in |
| [semiont-telemetry](./telemetry/README.md) | [![crates.io](https://img.shields.io/crates/v/semiont-telemetry.svg)](https://crates.io/crates/semiont-telemetry) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=rust-telemetry)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=rust-telemetry) | The SDK's spans and counts, reported to whatever OpenTelemetry the application installed. It exports nothing |
| [semiont-codegen](./codegen/README.md) | [![crates.io](https://img.shields.io/crates/v/semiont-codegen.svg)](https://crates.io/crates/semiont-codegen) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=rust-codegen)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=rust-codegen) | The build-time generator of Rust types from the spec. A build dependency of `semiont`: nobody adds it by hand |
| [semiont-core](./core/README.md) | Not published | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=rust-core)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=rust-core) | What the Rust services share and no client needs: the embedded spec and its validators, the configuration documents, the reach to the messaging broker |
| [semiont-http-service](./http-service/README.md) | Not published | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=rust-http-service)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=rust-http-service) | What the Rust services that serve HTTP share: connections a service can close from its side, the bearer credential, and the verifier of tokens from the trusted issuer |
| [semiont-observability](./observability/README.md) | Not published | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=rust-observability)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=rust-observability) | What a Rust service writes about itself: telemetry exported over OTLP, and log lines |

## Where things are

- One Cargo workspace, rooted here: [`Cargo.toml`](./Cargo.toml) names these crates and the Rust images' (`images/gateway`, `images/dispatcher`, `images/archivist`), beside [`Cargo.lock`](./Cargo.lock), cargo-deny's [`deny.toml`](./deny.toml) and the [`rust-toolchain.toml`](./rust-toolchain.toml) every Rust build takes its compiler from. Run `cargo` here; its build output is `target/`.
- CI measures the workspace's coverage once, with `cargo llvm-cov`, and uploads it under each crate's flag, `rust-<name>`, which Codecov scopes to the crate's directory.

The other languages, and which SDK a program installs, are in [packages/](../README.md).
