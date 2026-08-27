# Running tests

## Requirements

- A running backend with a known user account.
- A running Browser pointing at that backend.
- Both reachable from the host where Playwright runs.

Bringing the stack up is covered in
[containers.md](containers.md). This doc covers invocation only.

## Environment variables

Tests read four env vars. Two are required (no defaults, on purpose —
we don't want tests to silently use a fallback account); two have
local-dev defaults.

| Var | Default | Purpose |
|---|---|---|
| `E2E_EMAIL` | (required) | User to sign in as. |
| `E2E_PASSWORD` | (required) | Password for that user. |
| `E2E_BROWSER_URL` | `http://localhost:3000` | The Browser the tests drive. |
| `E2E_BACKEND_URL` | `http://localhost:4000` | Backend the sign-in form points at. |

The default test user seeded by the backend is
`admin@example.com` / `password`. Override via the env vars if you
seeded something else.

## Running from a container (recommended on macOS)

The dev stack runs in Apple containers on the `192.168.64.0/24` bridge, with
its ports published on the host. **Target the host bridge gateway,
`192.168.64.1`** — it routes to every published port (`:3000` frontend,
`:4000` backend, `:9090` worker health) and is stable across restarts.

**Do not use the containers' own IPs.** An earlier version of this page said
to `container ls | grep` them and re-grab before every run. Two things break
(both measured 2026-08-07):

- A stale address fails in `globalSetup` with `connect EHOSTUNREACH`, before
  any spec runs — and container IPs change on *every* stack restart.
- `19-worker-vitals` derives the worker health endpoint as
  `<backend-host>:9090`, which is only true when the published ports share a
  host. Aim it at the backend container and you get `ECONNREFUSED`.

`--network host` is not an option either — a Docker flag; Apple's `container`
rejects it with `Error: network host not found`.

**Run all tests:**

```sh
PW=$(node -p "require('./node_modules/@playwright/test/package.json').version")

container run --rm \
  -v "$(git rev-parse --show-toplevel):/workspace" \
  -w /workspace/tests/e2e \
  -e E2E_EMAIL=admin@example.com \
  -e E2E_PASSWORD=password \
  -e E2E_BROWSER_URL=http://192.168.64.1:3000 \
  -e E2E_BACKEND_URL=http://192.168.64.1:4000 \
  -e CI=1 \
  "mcr.microsoft.com/playwright:v$PW-noble" \
  npm test
```

> **`npm test`, not `npx playwright test`.** The `pretest` hook runs
> `tsc --noEmit` first. `tests/e2e` is not a root workspace, so that is the
> ONLY thing typechecking these specs — skip it and an SDK signature change
> surfaces as a runtime `TypeError` minutes into a browser run instead of a
> file:line in seconds. `npm test` also excludes `@slow`; see below.
>
> **Derive the image tag, never hardcode it.** It must match the installed
> library exactly. This page previously pinned `v1.61.0-noble` while the
> lockfile carried 1.62.0.

**Run one spec:** append the spec path as the last argument:

```sh
… npm test -- specs/02-open-resource.spec.ts
```

**Run one test within a spec:** add `-g '<title substring>'`:

```sh
… npm test -- -g 'opens the first resource'
```

**Repeat to catch flakes:** add `--repeat-each 5`. A deterministic
test passes 5/5; one that races SSE or React lifecycle fails a
fraction of the time. Use this any time a test "works on my machine"
but fails elsewhere, or before claiming a flake is fixed.

```sh
… npm test -- specs/02-open-resource.spec.ts --repeat-each 5
```

**Install deps into `tests/e2e/node_modules`** (one-time, inside the
container so its glibc matches what Playwright was built against):

```sh
container run --rm \
  -v "$(git rev-parse --show-toplevel):/workspace" \
  -w /workspace/tests/e2e \
  "mcr.microsoft.com/playwright:v$PW-noble" \
  npm install
```

## Running from the host

If you have Node + Playwright installed locally:

```sh
cd tests/e2e
npm install
npx playwright install chromium    # one-time browser download

export E2E_EMAIL=admin@example.com
export E2E_PASSWORD=password

# Headless:
npm test

# With a visible browser (useful for diagnosing failures):
npm run test:headed

# Step through with the Playwright inspector:
npm run test:debug

# Playwright's test runner UI:
npm run test:ui
```

From the **host** (not a container), `http://localhost:3000` /
`http://localhost:4000` work directly — the stack publishes those ports, and
the defaults in the table above already point there, so no env override is
needed. `192.168.64.1` is only required from *inside* a container, where
`localhost` resolves to the container itself.
