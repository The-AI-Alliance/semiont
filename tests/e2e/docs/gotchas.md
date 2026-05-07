# Known gotchas

Sharp edges that took real debugging the first time. Documented here
so future-you doesn't repeat the journey.

## `crypto.randomUUID` requires a secure context

`http://localhost` and `http://127.0.0.1` count as secure;
`http://<any-other-IP>` does not. When the tests run against container
IPs (e.g. `http://192.168.64.60:3000`), the frontend's calls to
`crypto.randomUUID` throw "is not a function".

The auth fixture polyfills it via `page.addInitScript` — see
[`fixtures/auth.ts`](../fixtures/auth.ts).

This is also a latent product bug — any user hitting the frontend via
HTTP from a non-localhost hostname will hit it. Fix is either to ship
an internal uuid that doesn't require a secure context, or to require
HTTPS in production.

## LoginForm's host field resets the protocol

The form's `handleHostChange` calls `defaultProtocol(newHost)`, which
picks HTTPS for IP-like hostnames. Set host *before* protocol in any
fixture filling in the form, or the dropdown flips back to HTTPS.

## The Connect form auto-opens when there are zero KBs

`KnowledgeBasePanel` auto-opens the Connect form when there are no
registered KBs. When at least one KB is registered, the form is
collapsed and you have to click "Add Knowledge Base" first. The auth
fixture races "email-field-visible" against
"add-knowledge-base-button-visible" and acts on whichever appears
first — so the fixture doesn't care which state you're in.

## Playwright version must match the Docker image tag

If `npm install` upgrades `@playwright/test`, pull the matching
`mcr.microsoft.com/playwright:<version>-noble` image. A mismatch
produces a "please update docker image as well" error at test
startup. See [containers.md](containers.md).

## Stale browser tabs poison backend logs

If `container logs semiont-backend` is a firehose of `Invalid token
signature` or `401` entries when no test is running, a lingering tab
from an earlier dev session is still holding an SSE connection with
an expired token and retrying. It won't break the tests directly, but
it makes backend logs unreadable while diagnosing. Close the tab
before debugging.

## Bus fixture order is load-bearing

The `bus` fixture's `addInitScript` must run before `page.goto`.
That's guaranteed when you destructure `bus` in the test params OR
use `signedInPage` (which depends on `bus`). If you build a helper
that creates its own `page` context, re-attach the bus log there with
`attachBusLog(page)`.

## Container IPs change on every restart

Apple's container runtime assigns a fresh bridge IP on every
`container run` and every `container start` — not just on rebuild.
Re-grab both the frontend and backend IP before each test run. See
[containers.md § IP refresh](containers.md#ip-refresh).

## `local-build.sh` doesn't build the backend image

The build script in this repo only builds the **frontend** container
image (and publishes `@semiont/*` packages to Verdaccio). The backend
image is built by the KB's own `.semiont/scripts/start.sh`.
Forgetting this leads to "why isn't my backend code change visible?"
confusion. See [containers.md § Rebuilding the backend](containers.md#rebuilding-the-backend).
