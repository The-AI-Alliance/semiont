# OCaml SDK development

The OCaml SDK is being implemented with Eio on OCaml 5. The implementation plan
is `.plans/SDK-OCAML.md` in the development checkout. The complete SDK is being
kept on one branch and one PR; this foundation does not yet provide a client.

Run the development checks in Apple `container`, without installing an OCaml
toolchain on the host:

```sh
bash packages/ocaml/run-container.sh
```

The runner checks generated source and package metadata, builds the pinned
toolchain image, checks formatting, runs protocol identifier cases and
[substrate probes](sdk/probes/README.md), and compiles external consumers
against the installed interfaces. Source stays in
the worktree; `_build` uses the `semiont-ocaml-sdk-build` native container volume
because dependency archives cannot reliably be extracted on a macOS bind mount.

`sdk/dune-project` owns package dependencies and generates `semiont.opam`.
`sdk/dune.lock` is the development dependency solution. Compiler, Dune,
formatter, repository revisions and the base image are pinned in `toolchain.json`; the
toolchain check refuses disagreement with Dune's constraints.

Regenerate committed sources from the protocol owners:

```sh
make generate-ocaml
make check-generated-ocaml
```

The generator reads the shared identifier and required-shape readers. It does
not read another SDK's implementation. It also derives probe fixtures from the
shared store/Unicode authorities and copies the repository license. Its
`--check` mode refuses drift without repairing source files.

Verify source-package independence after building the toolchain image:

```sh
bash packages/ocaml/check-source-package.sh
```

CI runs the substrate tests natively on Linux and macOS. The shared client
surface, conformance drivers and SDK feature implementation remain in progress;
a green substrate job is not a claim that the complete SDK is ready.

P1 records the installed compiler interface in `sdk/public-api.json`. The
first-stage `lint:ocaml-api` census verifies its source fingerprints. Native CI
rebuilds the library and compares compiler exports, including public roots,
aliases, constructors, records and type equalities. Deliberate stale-input and
snapshot mutations must fail while preserving the checked files.

After an intentional public-interface or compiler-input change, regenerate the
snapshot with `python3 api.py --write` in the OCaml container. The recipe in
`sdk/public-api.inputs.json` includes the library, lock directory, Dune files
and compiler-extraction tools. Full shared-client-surface integration continues
in P1.
