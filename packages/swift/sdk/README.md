# Semiont Swift SDK

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=swift-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The framework-free Swift SDK for Apple apps and Linux services. It is not published; P1 provides its build and concurrency gates.

From the repository root:

```bash
container run --rm -v "$PWD":/w -w /w/packages/swift/sdk "swift:$(packages/swift/scripts/swift-version.sh)" sh -c 'swift build && swift format lint --strict --recursive . && Scripts/census.sh && Scripts/refusals.sh'
```

Swift 6 language mode and warnings as errors apply to every target. The canary must fail with the concurrency diagnostic. Each future `Refusals/*.swift` program begins `// refused: <text>` and must fail with that message. The census forbids unchecked concurrency escapes and environment reads beyond `SEMIONT_BUS_LOG`. The formatter forbids force unwraps, force casts, force tries and implicitly unwrapped optionals throughout the package.

Tests arrive with generation; `SemiontTesting` arrives with its first implementation. Publishing is a separate plan.
