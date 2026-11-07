# OCaml substrate probes

These are P0 acceptance probes and candidate designs. They do not establish
that the SDK implements HTTP transports, sign-in storage, live queries or the
complete shared client surface. Their private libraries are not SDK exports.
The dependency observations below are the 2026-11-06 checkpoint; exact selected
versions live in the committed development lock.

Run them with `bash packages/ocaml/run-container.sh` from the repository root.
The CI matrix runs the same Dune tests and external-consumer checks natively
on Linux and macOS. Native Windows is outside the initial acceptance scope.

| Decision | Evidence and resulting design |
| --- | --- |
| Eio ownership | Owned child switches join cleanup after failed startup and close. Reader callbacks run in caller-owned fibers, allowing a callback to close its owner without joining itself. Concurrent close shares completion. |
| Renewal | A client-owned provider fiber can serve multiple waiters. Cancelling one waiter leaves the provider and other waiters running. |
| Domains | Mutable effectful SDK objects will be domain-affine, with explicit guards. Immutable IDs may cross domains. The candidate guard and native domain transfer are tested. |
| Events | One ordered queue per reader prevents work stealing and silent conflation. Queues retain every event until consumed or unsubscribed; a slow reader's backlog grows independently of the publisher. |
| HTTP | Cohttp's explicit connector bypasses its global proxy configuration. Calls open connections individually and neither redirect nor retry implicitly. A separate probe reuses a host-owned connection across two closed request scopes. Any pool supplied by a host needs an explicit lease/release policy; Cohttp itself provides no pool. |
| Deadlines | A manually controlled monotonic clock cancels outstanding TLS handshakes and native header/body reads at the requested instant. The handshake test waits for a real ClientHello at the peer before advancing time. A pre-deadline barrier proves no early completion; a deliberately early timer is rejected. No scheduler-idle heuristic or real sleep drives these tests. |
| Uploads and bodies | Reopening the source sends complete binary/UTF-8 bytes on each explicit attempt. An opaque body/reader candidate rejects a second consumer and retained readers after callback exit or cancellation, even if bytes remain buffered. |
| TLS and crypto | tls-eio/X509 accept a trusted matching certificate and reject wrong hostnames and untrusted issuers. The host explicitly starts the Mirage RNG; the SDK must not install global RNG, root or proxy policy. Eio supplies secure nonce bytes separately from jitter. RSA signing refuses a changed message. |
| JSON | Yojson.Raw preserves number literals. A strict scanner candidate rejects extensions, malformed UTF-8/surrogates and non-JSON number spellings before Raw decoding. Zarith and Decimal preserve large coefficients; QCheck runs 200 integer-fidelity cases. |
| Unicode | Uutf counts and searches scalar values against the generated shared offset corpus; byte offsets and grapheme counts cannot replace those offsets. This does not yet implement the SDK's annotation/text helpers. |
| Native files | A C `flock` candidate excludes an independent Python holder and releases after process death. Cancelled acquisition closes its descriptor. Owner-only sibling replacement preserves complete old/new documents, cleans failure paths and leaves the lock inode alone. Modes come from the shared owner-only policy. |
| Telemetry | OpenTelemetry 0.92 with host-selected ambient-context-eio storage isolates interleaved fibers, inherits context into child fibers and accepts explicit context transfer into another domain. The SDK will not install storage or an exporter. |
| Public interface | Matching compiler-libs read installed `.cmi` signatures, resolving includes, aliases, nested modules and functors. Mutation controls detect missing/extra exports, renamed fields, enum growth, duplicate aliases and revealed constructors. Separate GADT consumers refuse wrong scopes/results. Full shared-surface census integration remains P1. |

The clock instants and synthetic GADT operations here measure Eio/compiler
mechanics. They are not restatements of Semiont's clock or operation contracts;
the SDK still needs the shared contract cases through its production API.

`check-source-package.sh` at the parent language directory builds an archive
containing only this SDK in a fresh container, runs tests, installs its public
interfaces and compiles valid/refused consumers against that installation.
Neither sibling SDKs nor repository generators are mounted in that container.
The development lock supplies dependencies; `dune install --pkg=disabled`
installs the already built package without running dependency management.
Publishing and an opam-repository release remain separate work.
