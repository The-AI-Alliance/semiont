# Maintaining the repository

What keeps this repository healthy between releases: dependency updates, the gates an image passes before it is published, the rule for adding a gateway route, and the checks CI runs on the workspace itself. For releasing, see [RELEASE.md](RELEASE.md).

## Dependencies and CVEs

[Dependabot](../../.github/dependabot.yml) opens PRs weekly across six ecosystems: npm (repo root, `tests/e2e` and `tests/conformance`), Go modules (`apps/launcher` and `packages/sdk-go`), Cargo (the Rust workspace at the root, and the desktop app's `apps/desktop/src-tauri`), the repository's Rust toolchain (`rust-toolchain.toml`, which also names the gateway's builder image), GitHub Actions, and Docker base images (`apps/browser`, `apps/desktop`, and the seven service images). Related packages are grouped so they move together: `react`, `i18n`, `bundler-binaries`, `opentelemetry`, `gateway-crates`, and `desktop-crates`. `npm run lint:dependabot` fails when a manifest has no entry, or an entry no manifest, so a new Dockerfile, lockfile or crate cannot go un-updated unnoticed.

The gateway's crates are also held to RustSec's advisory database by [Gateway Crate Advisories](../../.github/workflows/gateway-advisories.yml) (`cargo deny`), on every PR that changes what the gateway links and daily, since the database changes without a commit. An advisory judged not to reach the gateway is ignored in [`deny.toml`](../../deny.toml) with its reason, and an ignore that stops matching fails the run.

Two things to know when reviewing those PRs:

**Native binaries must stay in lockstep.** `@rolldown/binding-*` and `lightningcss-*` are pinned per-platform in `optionalDependencies`. A tool bump that moves one without the others produces a CI failure of the form `cannot find module *.linux-x64-gnu.node`. That is what the `bundler-binaries` group exists to prevent — do not merge a partial set.

**For a CVE fix, move the consumer forward rather than pinning around it.** Bump the package that pulls in the vulnerable transitive dependency, regenerate the lockfile from scratch, accept the resulting drift, and validate with a real `npm ci`. Overrides and surgical lockfile edits are a last resort, not the default.

## The publish gates

Image publishing enforces this rather than trusting it. [`publish-service-images.yml`](../../.github/workflows/publish-service-images.yml), per image:

1. For an image that installs `@semiont/*` npm packages, verifies the matching version exists — such an image always bundles published packages, never a working tree. The gateway's image compiles the gateway from the repository instead
2. Trivy-scans the amd64 build for `HIGH`/`CRITICAL` CVEs and fails on any unfixed finding
3. Checks license policy against [`.github/licenses/exceptions.txt`](../../.github/licenses/exceptions.txt)
4. Pushes with version, `sha-<commit>`, and optionally `latest` tags
5. Publishes build-provenance and SBOM attestations as OCI artifacts

These gates fail **one at a time**: fixing a CVE finding can reveal a license finding behind it. Every service image strips npm from its runtime stage, so only the application's own dependencies are in scope.

The exceptions file is permissive-only by principle: it records licenses judged acceptable, never suppressions of findings.

See [Container Images](../operator/administration/IMAGES.md) for the full publishing process and how to verify an image you pulled.

## Authentication notes

Auth is applied **per route**, not globally with a public-endpoint allowlist. Each handler names the credential it needs ([`routes/`](../../apps/gateway/src/routes/), extractors in [`http.rs`](../../apps/gateway/src/http.rs)):

| Routes | Credential |
|---|---|
| `/api/users/me`, `/api/status`, `POST /api/tokens/media`, `POST /resources`, `GET /resources/{id}`, `GET /resources/{id}/jsonld`, `POST /bus/emit`, `POST /bus/subscribe` | a verified bearer (`Authenticated`) |
| `GET /api/resources/{id}` | a verified bearer, or that resource's media token (`MediaOrBearer`) |
| `POST /api/tokens/agent` | an issuer token carrying `semiont-service` |

A request on `/bus/*`, `/resources/*`, `/api/resources/*` or `/api/status` that matches no declared operation is authenticated before it is answered 404.

The spec declares four operations public: `GET /api/health`, `GET /`,
`GET /api/openapi.json` and `GET /.well-known/oauth-protected-resource`. The
[gateway conformance suite](../../tests/conformance/gateway/README.md) holds
this table honest for every operation the spec declares: a protected one answers
401 to an unauthenticated caller, a public one answers without challenging. The
other half is the gateway's own: before it listens, it compares its route table
with the spec it ships and refuses to start on any difference — a route the
spec does not declare, or a declared operation nothing serves. A new route is
declared in the spec first.

The maintenance consequence: **a new route is unauthenticated until its handler takes a credential.** Adding one means deciding its auth explicitly, and reviewing that decision belongs in the PR review — there is no global default to fall back on.

Who may authenticate is decided at the trusted issuer, not here. The gateway accepts any subject the issuer vouches for.

## Repository maintenance

- **Generated artifacts** — the `generated-artifacts` CI job fails on drift between the bus registry and generated code, between the bundled OpenAPI spec and `packages/sdk-go/client_gen.go`, and on Go schema coverage. When a spec changes, regenerate rather than hand-editing the output.
- **Phantom dependencies** — the `check-phantom-deps` job fails on imports not declared in the importing package's `package.json`. The monorepo hoists, so an undeclared dependency works locally and breaks for external consumers.
- **Internal `@semiont/*` pins** — apps must pin workspace siblings to `"*"`. An exact pin that does not match the workspace version installs the *published* copy nested, silently shadowing the workspace so the app builds against stale types.
