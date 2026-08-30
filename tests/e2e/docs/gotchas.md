# Known gotchas

Sharp edges that took real debugging the first time. Documented here
so future-you doesn't repeat the journey.

## `crypto.randomUUID` requires a secure context — browser code no longer calls it

`http://localhost` and `http://127.0.0.1` count as secure;
`http://<any-other-IP>` does not. Browsers expose `crypto.randomUUID`
only in secure contexts, so on container/LAN IPs (e.g.
`http://192.168.64.60:3000`) it is `undefined`.

Every id reachable from the browser — correlationIds, KB ids, and the
persisted ids built in `@semiont/core` — comes from that package's
`generateUuid()` / `uuidV4()`, built on `crypto.getRandomValues()`,
which is available in every context. So the suite needs no polyfill and
none exists.

(The gateway still calls `crypto.randomUUID` in a few Node-only places —
request ids, SSE connection ids. That is fine and deliberately left
alone: Node always has it, and "secure context" is a browser notion with
no Node equivalent. Only browser-reachable code is constrained here.)

If a "crypto.randomUUID is not a function" error ever appears in a test
run, someone added a direct call to browser-reachable code; route it
through the core helpers instead of re-adding a shim
(`.plans/bugs/crypto-randomuuid-insecure-context.md`).

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

## Stale browser tabs poison gateway logs

If `container logs semiont-gateway` is a firehose of `Invalid token
signature` or `401` entries when no test is running, a lingering tab
from an earlier dev session is still holding an SSE connection with
an expired token and retrying. It won't break the tests directly, but
it makes gateway logs unreadable while diagnosing. Close the tab
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
Re-grab both the Browser and gateway IP before each test run. See
[containers.md § IP refresh](containers.md#ip-refresh).

## `SEMIONT_VERSION=local` is load-bearing

`local-build.sh` builds all five Semiont images as local-only `:local`
tags — but the KB stack consumes them only when started with
`SEMIONT_VERSION=local semiont start`. Without it, the launcher pulls
the **published** images and your local code changes are invisible.
Forgetting this leads to "why isn't my gateway code change visible?"
confusion. See [containers.md § Restarting the stack on new images](containers.md#restarting-the-stack-on-new-images).
