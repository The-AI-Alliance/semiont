# Haskell P0 acceptance probes

[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?component=haskell-probes)](https://app.codecov.io/gh/The-AI-Alliance/semiont/components)

These are executable design experiments, using synthetic types rather than
copies of Semiont's protocol schemas. They establish candidate building blocks;
they are not the SDK or a replacement for the shared conformance suites.

## Run

From the repository root on macOS:

```sh
bash packages/haskell/run-container.sh
```

The script uses Apple `container` by default; CI passes `docker`. The image
copies the compiler from the versioned official Haskell image into Debian
Trixie, which supplies the Python standard-library peers and native build
dependencies. GHC 9.10's configured gold linker is a separate `binutils-gold`
package on Trixie. No host toolchain installation is needed.

The GHC pin is owned by `cabal.project`; `toolchain.sh` reads it for the image
build and checks the running compiler. `cabal-install.version` pins Cabal
independently of that image. The build downloads its official release and
verifies the architecture's digest from `cabal-install.sha256`; those two Linux
digests come from the release's `SHA256SUMS`. Update the version and digests
together. The runner checks the installed version, and native CI uses the same
version pin. `cabal.project.freeze` holds the
resolved dependency versions and flags against the dated package index.

Dependabot groups Haskell build-image updates into one weekly PR, with one
open version-update PR at a time. Cabal packages require a manual lockfile
refresh; update both the SDK and probes, regenerate the SDK's compiler API
inventory, and run their container suites together.

The runner checks Cabal metadata, builds with warnings as errors, compiles a
valid consumer, checks seven invalid consumers against specific diagnostics,
runs the real HTTP and native-lock peers with bounded failure timeouts, and
produces a source tarball. Dependencies are fetched through Cabal, not npm.

## Measured on Linux ARM64, 2026-11-05

| Probe | Observation |
|---|---|
| Typed channel and operation | GADTs distinguish scope and payload. Wrong scope, payload, and operation input fail compilation. |
| Opaque identifier | A hidden `newtype` constructor prevents both direct construction and external `coerce` from `Text`. |
| Closed outcomes | An incomplete pattern match fails compilation with the chosen warning policy. |
| JSON field presence | An explicit absent/null/value type round-trips all three cases through Aeson. This does not validate a schema generator. |
| Consumer-controlled time | Advancing an STM-backed time source releases its wait exactly at the deadline; cancelling another blocked wait preserves its asynchronous exception. |
| Stream ownership | A scoped callback releases after early consumption; an atomic guard refuses a second consumer; `streaming` preserves a distinct terminal result. |
| Equal state notices | A revisioned state cell exposes repeated equal notices to successive reads. This is not an event fan-out queue test. |
| Body cancellation | Cancelling a blocked read exits its response scope. The peer observes the incomplete socket close, and the same manager still makes another request. |
| Deadlines | The library's response timeout applies to headers. An explicit caller-controlled deadline raced against a body read cancels that read and closes its socket. |
| Proxy policy | An explicit `noProxy` manager works while the standard `http_proxy` setting points to an unusable endpoint. |
| Upload replay | A chunked upload source is reopened for each request and sends the complete body both times. No whole-body buffering is introduced by the probe. |
| Implicit HTTP retry | After warming a pooled connection, a dropped POST response causes two attempts with the library default and one with `managerRetryableException = const False`. The server counts the requests. |
| Native locking | Direct `flock` excludes Python's `fcntl.flock` in both directions across processes; contention uses a supplied wait callback, waits cancel, and process exit/death releases the lock. |
| Standalone source package | The Cabal source tarball rebuilt and passed the same suite in a separate container with only the archive and dependency cache mounted. |
| Crypto and text | `crypton` provides the SHA-256 known-answer check, RSA signing/verification and secure random bytes. `text` counts supplementary and combining characters as code points. |
| Telemetry | The pinned OpenTelemetry API delivers two related spans to a host processor, keeps context across an explicitly scoped async task, uses a host propagator, and delivers counter measurements to a host meter. The host retains provider shutdown. |
| Simulation alternative | `io-sim` advances five seconds and enforces a deadline without waiting in real time. A compiler-refusal case shows that the concrete HTTP library's IO action cannot simply run in `IOSim`; using it requires a different transport composition. |

The upstream [`http-client` manager implementation](https://github.com/snoyberg/http-client/blob/http-client-0.7.19/http-client/Network/HTTP/Client/Manager.hs)
also establishes that `closeManager` is a deprecated no-op. Response cleanup is
the meaningful deterministic scope in this probe.

## Decisions supported, and still open

The results support continuing with GADTs and opaque newtypes, explicit Aeson
presence handling, scoped `streaming`, STM state and consumption guards,
interruptible `async` tasks, and supplied IO waits. They do not settle the full
public signatures or the complete time/jitter surface. The simulation probe
supports keeping the concrete IO facade with supplied domain waits: the
alternative works, but would require a polymorphic HTTP boundary throughout.

The HTTP boundary needs a decision before implementing the production adapter:
an opaque caller-provided `Manager` cannot be inspected for implicit retry
policy or explicitly closed through a meaningful public shutdown API. The plan
must not promise either guarantee from that value alone. Candidate boundaries
include caller-supplied `ManagerSettings` with explicit SDK request policy or a
caller-provided transport. Header timeouts cannot implement body deadlines.

The stock OpenAPI Generator's `haskell-http-client` output was compared using
version 7.17.0 and a synthetic optional-nullable field: it generated `Maybe Text`,
decoded with `.:?`, and omitted nulls on encode. That loses explicit null
membership, so the SDK uses its own generator. The SDK suite now checks its
generated schema samples and resolved conformance-corpus payloads.

GHCi's compiler-derived `:browse!` output was also measured against the real
library. It reports the exported GADTs, constructors, functions, and resolved
types through module re-exports. P1 still needs the inventory parser, freshness
gate, and surface-lint integration.

Still required for P0 are crypto and telemetry platform checks, full time/jitter signatures
and simulation comparison, non-replayable upload behavior, launcher-owned lock
and store integration, durable replacement, and native macOS/Windows locking
and lifecycle checks. Linux Python interoperability alone establishes neither
launcher compatibility nor Windows support. The isolated source build measures
this probe package; the eventual consumer SDK must establish its own standalone
distribution acceptance.
