# semiont-codegen (Rust)

The generator the Rust crates' build scripts share: `specs/src` bundled into
whole documents, and Rust types generated from their component schemas. One
generator, so the SDK's protocol types and a service's own types are never
generated two ways. It knows the shapes the spec uses and refuses any other,
so a new shape fails the build rather than generating something wrong.

A build dependency only; no binary links it.
