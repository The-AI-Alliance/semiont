# Semiont Maintenance Guide

Routine maintenance for a Semiont deployment and for this repository.

This covers the **container stack the `semiont` launcher runs** — the deployment this repo supports. For diagnosing a specific failure, see [Troubleshooting](TROUBLESHOOTING.md). For distributed tracing, RED metrics, and trace-tagged log fields, see [Observability](OBSERVABILITY.md); structured logs are auto-tagged with `trace_id` and `span_id` when an OTel exporter is configured, so a log query can jump to the corresponding trace.

## What actually needs maintaining

A launcher-run stack has no scheduled operational chores — no scaling to tune, no backup window to watch, no alarms to review. What does need attention:

| Concern | Cadence | Why |
|---|---|---|
| [Dependency and CVE updates](#dependencies-and-cves) | Weekly (automated) | Published images fail their own CVE gate otherwise |
| [Image upgrades](#upgrading-a-stack) | When a version ships | New images, no migration — Semiont keeps no schema |
| [Event log git hygiene](#the-event-log-is-the-thing-to-protect) | Continuous | The event log is the system of record |
| [Secret rotation](#secret-rotation) | On compromise or policy | Rotation invalidates live tokens |
| [Persistent state growth](#persistent-state-and-disk) | Occasionally | Stores grow; orphaned state accumulates |
| [Log review](#log-review) | On symptom | Not on a schedule — this is not multi-tenant infrastructure |

## Dependencies and CVEs

[Dependabot](../../../.github/dependabot.yml) opens PRs weekly across four ecosystems: npm (repo root and `tests/e2e`), Go modules (`apps/launcher` and `packages/sdk-go`), GitHub Actions, and Docker base images (`apps/browser`, `apps/desktop`, and the six service images). Related packages are grouped so they move together: `react`, `i18n`, `bundler-binaries`, and `opentelemetry`.

Two things to know when reviewing those PRs:

**Native binaries must stay in lockstep.** `@rolldown/binding-*` and `lightningcss-*` are pinned per-platform in `optionalDependencies`. A tool bump that moves one without the others produces a CI failure of the form `cannot find module *.linux-x64-gnu.node`. That is what the `bundler-binaries` group exists to prevent — do not merge a partial set.

**For a CVE fix, move the consumer forward rather than pinning around it.** Bump the package that pulls in the vulnerable transitive dependency, regenerate the lockfile from scratch, accept the resulting drift, and validate with a real `npm ci`. Overrides and surgical lockfile edits are a last resort, not the default.

### The publish gates

Image publishing enforces this rather than trusting it. [`publish-service-images.yml`](../../../.github/workflows/publish-service-images.yml), per image:

1. Verifies the matching `@semiont/*` npm package version exists — an image always bundles published packages, never a working tree
2. Trivy-scans the amd64 build for `HIGH`/`CRITICAL` CVEs and fails on any unfixed finding
3. Checks license policy against [`.github/licenses/exceptions.txt`](../../../.github/licenses/exceptions.txt)
4. Pushes with version, `sha-<commit>`, and optionally `latest` tags
5. Publishes build-provenance and SBOM attestations as OCI artifacts

These gates fail **one at a time**: fixing a CVE finding can reveal a license finding behind it. The `semiont-gateway` image faces the longest stack of them, because it keeps npm at runtime — so npm's own bundled tree is in scope alongside the application's dependencies.

The exceptions file is permissive-only by principle: it records licenses judged acceptable, never suppressions of findings.

See [Container Images](IMAGES.md) for the full publishing process and how to verify an image you pulled.

## Upgrading a stack

No schema migration is involved: the gateway holds no database, and Keycloak manages its own schema on its first boot with a given image. So upgrading is:

```bash
semiont stop
SEMIONT_VERSION=0.5.21 semiont start
```

Watch the gateway come up. It refuses to start rather than serve half-configured — a missing signing key or service-account credential exits the container:

```bash
semiont logs --service gateway
semiont status
```

If `start` refuses because persisted database state was written by a different image version, read the refusal before working around it — it is protecting a store from corruption. The way out is [`semiont clean`](DATABASE.md#resetting), which discards that state.

## The event log is the thing to protect

`.semiont/events/` in the KB's git repo is the system of record. The graph, the vector store, and the materialized views are projections — all rebuildable, none worth backing up.

That makes maintenance mostly git discipline:

```bash
cd /path/to/kb
git status .semiont/events        # Uncommitted events are unprotected
git add .semiont/events && git commit -m "events"
git push
```

Untracked event files are not disposable. If events appear to be missing, check git history before concluding anything was lost — see [Troubleshooting](TROUBLESHOOTING.md).

With `gitSync` enabled, every append stages the event log file, and once committed, git's object hashes make tampering evident. See [Storage Layout](../../../packages/event-sourcing/docs/STORAGE-LAYOUT.md).

For archive export and restore, see [BACKUP.md](BACKUP.md). PostgreSQL holds Keycloak's realm and its accounts — backing it up is not backing up the knowledge base.

## Secret rotation

Three secrets matter, and rotating them is not free:

**`JWT_SECRET`** — signs the tokens the gateway itself mints: software-agent and media tokens. It does NOT sign people's, which are the issuer's and verify against its published keys. Rotating it invalidates every agent and media token previously issued, including ones held by running workers; people are unaffected. Rotate through the comma-separated ring rather than replacing the value outright ([Authentication](AUTHENTICATION.md#rotating-jwt_secret-without-cutting-off-the-sidecars)). The symptom of a rotation nobody re-authenticated after is `Invalid token signature` in the gateway log, and jobs that never start. Plan a rotation as "every client must re-authenticate," and restart the whole stack rather than one service. Minimum 32 characters, enforced at startup ([`auth/jwt.ts`](../../../apps/gateway/src/auth/jwt.ts)).

**`SEMIONT_OIDC_CLIENT_SECRET_<SERVICE>`** — each service's own credential at the knowledge base's issuer, generated and persisted per root on first use. They do not have to match each other; separate credentials are the point. Rotating one means changing it at the issuer and in that root's state, and restarting only that service. The realm imports **only on first boot**, so a client added after a realm already exists will not appear in it.

**Provider API keys** (`ANTHROPIC_API_KEY` and friends) — referenced from config as `${ANTHROPIC_API_KEY}` and read from the launcher's environment, so rotating one is an environment change plus a restart of whatever consumes it.

Revoking one person's session is not a `JWT_SECRET` operation and not a Semiont operation at all: disable the account at the issuer. That stops new tokens and the refresh grant immediately; the access token they hold works until it expires. Signing out in a client revokes that client's refresh token at the issuer (RFC 7009) and drops the access token locally. There is no server-side session to invalidate, because the gateway stores nothing about a caller.

See [SECRETS.md](../services/SECRETS.md) and [AUTHENTICATION.md](AUTHENTICATION.md).

## Persistent state and disk

`semiont stop` deliberately leaves PostgreSQL, Qdrant, and Neo4j data behind so the next `start` reuses it. Over time, and across KB roots, that accumulates:

```bash
semiont status --verbose      # Per-root state and its disk consumption
```

The verbose report calls out **orphaned** state — state whose KB directory no longer exists — along with the `clean` command that removes it. `semiont clean` is the only thing that deletes persistent state; it requires the stack stopped, and it never touches the event log:

```bash
semiont clean --dry-run              # What would go, and how big
semiont clean --store vectors        # One store: database, graph, vectors,
                                     #   anchored-text, or state
semiont clean --root <path|name|key> # Another root, including an orphan
```

The Ollama model cache is separate, and can be large:

```bash
semiont start --clean-ollama         # Remove the model cache volume and exit
```

## Log review

Services log structured JSON to stdout. There is no aggregation layer and no retention policy to manage — the container engine holds the logs, and containers run without `--rm` so a crashed service's logs survive.

```bash
semiont logs                                    # All seven services
semiont logs --service gateway | grep -i error
```

Review on symptom, not on a schedule. When something is wrong, [Troubleshooting](TROUBLESHOOTING.md) starts from `semiont status`.

## Authentication notes

Auth is applied **per router**, not globally with a public-endpoint allowlist. Each router that needs it installs `authMiddleware` itself:

| Router | Protected paths |
|---|---|
| `resources` | `/api/resources/*`, `/api/clone-tokens/*`, `/resources/*` ([`routes/resources/shared.ts`](../../../apps/gateway/src/routes/resources/shared.ts)) |
| `status` | `/api/status` |
| `bus` | `/bus/*` ([`routes/bus.ts`](../../../apps/gateway/src/routes/bus.ts)) |

`/api/health` and `POST /api/tokens/agent` are the only API operations the spec
declares public, alongside the documentation meta-routes and the root splash page.
`route-spec-coverage.test.ts` holds this table honest: every registered route must
either answer 401 to an unauthenticated caller or be declared public in the spec.

The maintenance consequence: **a new router is unauthenticated until you say otherwise.** Adding one means deciding its auth explicitly, and reviewing that decision belongs in the PR review — there is no global default to fall back on.

Who may authenticate is decided at the trusted issuer, not here. The gateway accepts any subject the issuer vouches for.

## Repository maintenance

- **Generated artifacts** — the `generated-artifacts` CI job fails on drift between the bus registry and generated code, between the bundled OpenAPI spec and `packages/sdk-go/client_gen.go`, and on Go schema coverage. When a spec changes, regenerate rather than hand-editing the output.
- **Phantom dependencies** — the `check-phantom-deps` job fails on imports not declared in the importing package's `package.json`. The monorepo hoists, so an undeclared dependency works locally and breaks for external consumers.
- **Internal `@semiont/*` pins** — apps must pin workspace siblings to `"*"`. An exact pin that does not match the workspace version installs the *published* copy nested, silently shadowing the workspace so the app builds against stale types.

## Related

- [Troubleshooting](TROUBLESHOOTING.md) — diagnosing a specific failure
- [Observability](OBSERVABILITY.md) — traces, metrics, log correlation
- [Container Images](IMAGES.md) — publishing, versioning, attestations
- [Database Guide](DATABASE.md) — migrations, resets
- [BACKUP.md](BACKUP.md) — archive format, export, restore
- [SECRETS.md](../services/SECRETS.md) — credential handling
- [AUTHENTICATION.md](AUTHENTICATION.md) — accounts, JWTs, OAuth
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities
- [SCALING.md](SCALING.md) — capacity considerations
