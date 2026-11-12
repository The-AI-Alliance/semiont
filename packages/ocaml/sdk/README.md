# Semiont OCaml SDK

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=ocaml-sdk)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

Build an Eio application, script, or worker that talks to a Semiont knowledge base. The SDK includes typed bus operations, sign-in, delegation, and live queries.

## Install

Build the `semiont` package from `packages/ocaml/sdk` in this checkout. The compiler and Dune versions are pinned in [toolchain.json](../toolchain.json).

```sh
cd packages/ocaml/sdk
dune build @install
dune install --pkg=disabled --prefix "$PWD/_installed"
```

Add `semiont` to your application's Dune `libraries` stanza and make the installed library available on its OCaml package path. The [builder guide](../../../docs/builder/OCAML.md) shows how the client fits into an application.

## Sign in and connect

- **Script.** Discover the issuer with `OAuth.discover`, obtain the user code with `OAuth.begin_device`, then call `OAuth.await_device` with the application's clock. To reuse the launcher's sign-in on Linux or macOS, open the launcher directory with `Sign_in_store.make` and select the stack with `Sign_in_store.session`.
- **Interactive application.** Use `Registry.begin_sign_in` to store the pending PKCE exchange and get the authorization URL. After the redirect, use `Registry.complete_sign_in` to consume the callback and verify the knowledge base. Supply a `Storage.t` with an atomic update when multiple application contexts share the store.
- **Agent.** Use `Agent.sign_in` with a client secret or RSA key. For RSA assertions, initialize Mirage's secure random generator and supply a fresh assertion ID. Use `Service_token` when you need the issuer bearer or authorization header independently of a client.

Pass the credential session, Eio switch, clock, and gateway HTTP adapter to `Client.connect`, with the channels its bus subscribes to as `~global`: `Bus_registry.bridged_channels` for a full client. The application owns the HTTP adapter, the client, and the lifetime of its Eio switch. The [sign-in guide](../../../docs/builder/SIGN-IN.md) describes the grants.

`Client.errors` says each failure of the client's transport, from its first request on. `State_units.Session.errors` says the session's own errors and what its client says, in the order met. The first reader of each is first given the latest said before it came. A registry's factory builds each knowledge base's session and reads none of its errors. `Registry.activate` reads them from the first thing the session said: `Registry.errors` says the session's own errors, and a refusal for lack of permission goes to the signals the factory was handed. A session the factory cannot build is said on `Registry.errors` as `session.construct-failed`. `Registry.close` closes the active session's client and then ends the session and `Registry.errors`, so what the client's closing flush meets is said first; an activation after it builds nothing. `Error_codes` names each code of the bus request, transport, job and session vocabularies of `protocol/specs/src/errors/codes.json`, from which it is generated.

## Live queries

Get a query from `Client.Browse`, `Client.Match`, or `Client.Gather`. Use `Client.fresh` for a fresh answer, or `Client.observe` for state updates until you release the observation. The [checked example](examples/builder.ml) reads and watches a resource.

For a durable cache, pass a `Storage_persister` to `Client.connect`. Give it a key scoped to the knowledge base and signed-in principal. The client debounces cache writes and advances a stored replay cursor only when the matching scoped cache values can be saved with it. A write the storage refuses stays owed, and the client says it on `Client.errors` as `session.save-refused`.

## Delegate work

Use `Client.Mark.delegate` or `Client.Yield.delegate` with `Client.delegation client`. The client already connects the follower to its subscription. Supply validated parameters and callbacks for reports, terminal failures, and closure. The returned function releases the follower.

## Run a worker

Use `Client.Job.claim` and `Claims.next` to take a job, then use `Worker` to start it, report progress, checkpoint, and settle it. Include `Worker.channels` in the client's subscription and add `Worker.commit_channels` for annotation commits. `Claims.refused` and `Claims.stalled` say each claim refused and each held job that stalls: the first reader of each is first given the latest said before it came, in order, and a reader who comes after `Claims.stop` hears only the end.

## Develop and verify

```sh
bash packages/ocaml/run-container.sh
bash packages/ocaml/check-source-package.sh
```

The first command builds the pinned toolchain in Apple `container` and runs the development checks. The second builds and installs an isolated source archive and verifies the installed compiler interface. Regenerate protocol-derived sources with `make generate-ocaml` and verify them with `make check-generated-ocaml`.

CI runs the tests instrumented by `bisect_ppx_ng` and uploads their line coverage:

```sh
mkdir -p /tmp/ocaml-coverage
BISECT_FILE=/tmp/ocaml-coverage/bisect dune runtest --force --instrument-with bisect_ppx_ng
dune exec -- bisect-ppx-report summary --coverage-path /tmp/ocaml-coverage
```

A test runs in a sandbox that Dune deletes, so `BISECT_FILE` writes the coverage files outside the build.
