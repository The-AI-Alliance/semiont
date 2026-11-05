# Haskell SDK development

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=haskell)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

The Haskell SDK is under construction toward full parity on one branch. Its
model library and typed channel descriptors are implemented; the client and
conformance drivers remain to be built. The implementation plan is
`.plans/SDK-HASKELL.md` in the development checkout.

Run the compiled acceptance probes in Apple `container`, without installing a
Haskell toolchain on the host:

```sh
bash packages/haskell/run-container.sh
```

CI runs the same entry point with `docker` as its argument. It checks both
[the SDK](sdk/README.md) and [the design probes](probes/README.md).

| Package | Coverage |
| --- | --- |
| [SDK](./sdk/README.md) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=haskell-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) |
| [Design probes](./probes/README.md) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=haskell-probes)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components) |
