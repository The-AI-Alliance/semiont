# Haskell SDK development

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=haskell)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The Haskell SDK is under construction toward full parity on one branch. Its
model library, typed bus, common transport runtime, operation consumption,
retry support, and launcher discovery are implemented; the client and conformance drivers
remain to be built.
The [SDK README](sdk/README.md) follows the other SDK guides, with feature status
and local package setup. Development continues on
[one SDK PR](https://github.com/The-AI-Alliance/semiont/pull/2104).
The implementation plan is
`.plans/SDK-HASKELL.md` in the development checkout.

Run the compiled acceptance probes in Apple `container`, without installing a
Haskell toolchain on the host:

```sh
bash packages/haskell/run-container.sh
```

CI runs the same entry point with `docker` as its argument. It checks both
[the SDK](sdk/README.md) and [the design probes](probes/README.md). Both
write HPC coverage as LCOV, with line hits, function counts and branch counts
reported separately. The path normalizer changes only source paths.

| Package | Coverage |
| --- | --- |
| [SDK](./sdk/README.md) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=haskell-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) |
| [Design probes](./probes/README.md) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=haskell-probes)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) |
