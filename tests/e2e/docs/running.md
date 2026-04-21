# Running tests

## Requirements

- A running backend with a known user account.
- A running frontend pointing at that backend.
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
| `E2E_FRONTEND_URL` | `http://localhost:3000` | Frontend the browser drives. |
| `E2E_BACKEND_URL` | `http://localhost:4000` | Backend the sign-in form points at. |

The default test user seeded by the backend is
`admin@example.com` / `password`. Override via the env vars if you
seeded something else.

## Running from a container (recommended on macOS)

The dev stack runs in Apple containers on the `192.168.64.0/24`
bridge. A containerized Playwright image can reach both the frontend
and backend containers directly by IP — no host port-forwarding needed.

**Always re-grab both IPs before each run** (they change on every
restart — see [containers.md](containers.md#ip-refresh)):

```sh
container ls | grep -E 'semiont-(frontend|backend)'
```

**Run all tests:**

```sh
container run --rm \
  -v "$(git rev-parse --show-toplevel):/workspace" \
  -w /workspace/tests/e2e \
  -e E2E_EMAIL=admin@example.com \
  -e E2E_PASSWORD=password \
  -e E2E_FRONTEND_URL=http://<frontend-ip>:3000 \
  -e E2E_BACKEND_URL=http://<backend-ip>:4000 \
  -e CI=1 \
  mcr.microsoft.com/playwright:v1.59.1-noble \
  npx playwright test
```

**Run one spec:** append the spec path as the last argument:

```sh
… npx playwright test specs/02-open-resource.spec.ts
```

**Run one test within a spec:** add `-g '<title substring>'`:

```sh
… npx playwright test -g 'opens the first resource'
```

**Repeat to catch flakes:** add `--repeat-each 5`. A deterministic
test passes 5/5; one that races SSE or React lifecycle fails a
fraction of the time. Use this any time a test "works on my machine"
but fails elsewhere, or before claiming a flake is fixed.

```sh
… npx playwright test specs/02-open-resource.spec.ts --repeat-each 5
```

**Install deps into `tests/e2e/node_modules`** (one-time, inside the
container so its glibc matches what Playwright was built against):

```sh
container run --rm \
  -v "$(git rev-parse --show-toplevel):/workspace" \
  -w /workspace/tests/e2e \
  mcr.microsoft.com/playwright:v1.59.1-noble \
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

When running from the host against the containerized stack, you can
use `http://localhost:3000` / `http://localhost:4000` if the container
runtime exposes those ports to the host. Otherwise, use the bridge IPs
like the container-run invocation above.
