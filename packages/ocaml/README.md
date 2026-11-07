# OCaml SDK development

The OCaml SDK is being implemented with Eio on OCaml 5. The implementation plan
is `.plans/SDK-OCAML.md` in the development checkout. The complete SDK is being
kept on one branch and one PR; this foundation does not yet provide a client.

Run the development checks in Apple `container`, without installing an OCaml
toolchain on the host:

```sh
bash packages/ocaml/run-container.sh
```

The runner checks generated identifiers, builds the pinned toolchain image,
compiles the library, runs protocol identifier cases and runtime probes, and
compiles external consumers against the installed interfaces. Source stays in
the worktree; `_build` uses the `semiont-ocaml-sdk-build` native container volume
because dependency archives cannot reliably be extracted on a macOS bind mount.

`sdk/dune-project` owns package dependencies and generates `semiont.opam`.
`sdk/dune.lock` is the development dependency solution. Compiler, Dune,
repository revisions and the base image are pinned in `toolchain.json`; the
toolchain check refuses disagreement with Dune's constraints.

Regenerate committed sources from the protocol owners:

```sh
make generate-ocaml
make check-generated-ocaml
```

The generator reads the shared identifier and required-shape readers. It does
not read another SDK's implementation. Its `--check` mode refuses drift without
repairing source files.
