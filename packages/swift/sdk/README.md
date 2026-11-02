# Semiont Swift SDK

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=swift-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The framework-free Swift SDK for Apple apps and Linux services. It is not published; its checked identifiers, wire models and protocol tables are generated from the spec at build time.

From the repository root:

```bash
container run --rm --memory 8g -e HOME=/tmp/swift-home -v "$PWD":/w -w /w/packages/swift/sdk "swift:$(packages/swift/scripts/swift-version.sh)" sh -c 'mkdir -p "$HOME" && swift test --enable-code-coverage && Scripts/coverage.sh && swift format lint --strict --recursive . && Scripts/census.sh && Scripts/refusals.sh'
```

Swift 6 language mode and warnings as errors apply to every target. The canary must fail with the concurrency diagnostic. Each future `Refusals/*.swift` program begins `// refused: <text>` and must fail with that message. The census forbids unchecked concurrency escapes and environment reads beyond `SEMIONT_BUS_LOG`. The formatter forbids force unwraps, force casts, force tries and implicitly unwrapped optionals throughout the package.

The tests round-trip payloads from the three conformance corpora, run every identifier case, and verify nullable members, open objects, table generation and refused schema shapes. `SemiontTesting` arrives with its first implementation. Publishing is a separate plan.

The build-tool plugin runs the native Swift generator over `specs/src`, including files outside the SwiftPM package. Generated models and test dispatch live only in `.build`. Models keep timestamps and URIs as strings, use checked value types for identifiers, and preserve the three states of an optional nullable member with `Stated`. `JSONValue` carries values in open objects. Required nullable members must be present, even when null.

`Scripts/coverage.sh` exports both compiled test libraries; the toolchain's default JSON report covers only the last one. Coverage includes the generator, which is also run over the complete spec by its tests. The testing product and transport remain later phases.
