# Haskell SDK development

The Haskell SDK is in its P0 design experiments. There is no consumer library
or protocol conformance claim yet. The implementation plan is
`.plans/SDK-HASKELL.md` in the development checkout.

Run the compiled acceptance probes in Apple `container`, without installing a
Haskell toolchain on the host:

```sh
bash packages/haskell/probes/run-container.sh
```

CI runs the same entry point with `docker` as its argument. See
[the probe results and remaining decisions](probes/README.md).
