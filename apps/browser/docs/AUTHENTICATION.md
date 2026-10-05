# Browser Authentication Architecture

## Overview

A user is always authenticated **against a specific Knowledge Base
(KB)** — never globally. Switching KBs means switching sessions
atomically. The Browser stores one JWT pair per KB in
`localStorage` and validates on session construction via the gateway's
`GET /api/users/me` endpoint.

There is no httpOnly cookie and no global session. Session state is owned by a
single `SemiontBrowser` singleton that lives in `@semiont/sdk` and is exposed to
React via the `SemiontProvider` + `useSemiont()` pair in `@semiont/react-ui`.

For the class-level story (observables, lifetimes, invariants), see
[SESSION.md in `@semiont/react-ui`](../../../docs/builder/react-ui/SESSION.md).
This doc covers the **Browser-app** concerns: where providers mount,
how route protection is expressed, how sign-in / sign-out flow, and
how out-of-tree code signals the provider.

## Core pieces

### `SemiontBrowser` (singleton)

App-level container owning the KB list, active selection, session,
open-resources tab state, identity token, and the app-scoped event bus
(each session's client owns the other). Lives in `@semiont/sdk` so CLI / MCP /
workers can use it too.

Key observables the UI reads:

- `kbs$` — configured KB list
- `activeKbId$` — the selected KB (set, even when signed out)
- `activeSession$` — live `SemiontSession | null`
- `sessionActivating$` — true while `setActiveKb` / `signIn` is in
  flight awaiting `session.ready`. **The only valid loading
  indicator.** UIs that want a spinner during session construction
  must AND-gate on this, otherwise they stick on the spinner
  forever after sign-out (see [Sign-out semantics](#sign-out-semantics)).
- `activeSignals$` — the active session's `SessionSignals` (what the auth modals read)
- `openResources$`, `lastViewedResource$` (both per-KB projections of the active, connected KB), `identityToken$`, `error$`

### `SemiontProvider` + `useSemiont()` (React surface)

The only React export that touches session state. Mount once at the
app root — not only inside protected routes. The provider is cheap;
zero-KB and signed-out are first-class states, not pre-app states.

```tsx
import { SemiontProvider } from '@semiont/react-ui';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <SemiontProvider>{children}</SemiontProvider>;
}
```

Inside components:

```tsx
import { useSemiont, useObservable } from '@semiont/react-ui';

function Whatever() {
  const semiont = useSemiont();
  const session = useObservable(semiont.activeSession$);
  const user = useObservable(session?.user$);

  if (!user) return <p>Not signed in</p>;
  return <div>Hello, {user.name}</div>;
}
```

`useSemiont()` throws if no `SemiontProvider` is mounted. There is no
fallback — auth misuse must fail loudly.

### `KnowledgeBasePanel` (UI)

User-facing UI for adding / switching / signing out of KBs. Calls
`semiont.beginSignIn({ target, redirectUri })` to add or re-authenticate a KB,
`semiont.setActiveKb(id)`, `semiont.removeKb(id)` and `semiont.signOut(id)`.
Never writes to `localStorage` directly — all persistence goes through
`SemiontBrowser`'s `SessionStorage` adapter (`SemiontProvider` defaults it to
`WebBrowserStorage`).

## Route protection pattern

A protected layout reads three observables and branches on three
states. The order matters (`apps/browser/src/app/[locale]/know/layout.tsx`,
abridged):

```tsx
import { Outlet } from 'react-router';
import { KnowledgeSidebarWrapper } from '@/components/knowledge/KnowledgeSidebarWrapper';

declare function UnauthenticatedKnowledgeLayout(): React.JSX.Element; // file-local: empty state + toolbar

function KnowledgeLayoutBody() {
  const semiont = useSemiont();
  const activeKbId = useObservable(semiont.activeKbId$);
  const session = useObservable(semiont.activeSession$);
  const sessionActivating = useObservable(semiont.sessionActivating$);
  const token = useObservable(session?.token$);
  const activeKnowledgeBase = session?.kb ?? null;

  // 1. Session under construction — brief, shown only during active activation.
  const isLoading = activeKbId != null && session == null && sessionActivating;
  if (isLoading) return <p>Loading...</p>;

  // 2. Unauth — active KB exists but no session (signed out, or no credentials).
  if (!activeKnowledgeBase || !token) return <UnauthenticatedKnowledgeLayout />;

  // 3. Authed — the sidebar and the routed page.
  return (
    <ResourceAnnotationsProvider>
      <KnowledgeSidebarWrapper />
      <Outlet />
    </ResourceAnnotationsProvider>
  );
}
```

The AND-gate on `sessionActivating` is load-bearing. Without it,
every `signOut` leaves the layout stuck on the spinner forever —
`activeKbId` is still set, `session` is null, and there's nothing to
arrive.

## Sign-out semantics

Calling `browser.signOut(id)` does three things:

1. Clears stored tokens for that KB from storage.
2. Revokes the refresh token at the issuer that issued it, when the stored
   session records a revocation endpoint — best-effort: an unreachable
   issuer does not keep the person signed in.
3. If the KB is active: disposes the `SemiontSession` and its
   `SessionSignals`, and emits `null` on `activeSession$` and
   `activeSignals$`.

It deliberately does **not** clear `activeKbId$`. Per the app's
design: "all KB entries are shown, one is active, regardless of
whether the auth is current." Sign-out is a credentials concept, not
a selection concept.

The resulting state (active KB set, session null, `sessionActivating`
false) is how the layout knows to render the unauth view with a
"signed out, click the KB to re-auth" affordance.

## Authentication flow

```text
1. User adds a KB via KnowledgeBasePanel
   └── semiont.beginSignIn(...) discovers the issuer the KB trusts
       └── The person signs in at the issuer, which redirects to /:locale/auth/callback
           └── semiont.completeSignIn(url) exchanges the code for access + refresh tokens
               └── Browser stores them, signs in the entry for the KB that answered,
                   and constructs a SemiontSession

2. Page mount with existing stored tokens (reload, new tab)
   └── SemiontBrowser constructor reads activeKbId from storage
       └── Kicks off setActiveKb(id), sessionActivating$ → true
           └── SemiontSession constructs, validates token via /api/users/me
               ├── 200 → activeSession$.next(session), sessionActivating$ → false
               └── 401 → the token is renewed once at the issuer and asked about once more;
                         a session that cannot be renewed, or whose renewed token is
                         refused too, clears its stored tokens and its token$, and
                         onAuthFailed raises notifySessionEnded with why (see below)

3. Out-of-band 401/403 from any HTTP / bus call
   └── transport stamps unauthorized/forbidden → session.errors$ → SemiontBrowser
       └── 401 → session.refresh(); a session that cannot be renewed raises notifySessionEnded
       └── 403 → the active session's SessionSignals (notifyPermissionDenied)
           └── Modal reads the flag via useObservable and surfaces

4. Sign out
   └── User clicks per-KB sign-out in KnowledgeBasePanel
       └── browser.signOut(id) — clears tokens, disposes session
           └── activeKbId$ stays set; layout drops into UnauthenticatedKnowledgeLayout
```

## OAuth flow

Sign-in happens at the issuer the knowledge base trusts — the Browser never
takes a password. The flow:

1. The person adds a KB in `KnowledgeBasePanel`, or re-authenticates one.
2. `semiont.beginSignIn({ target, redirectUri })` discovers the KB's issuer
   from its protected-resource metadata (RFC 9728), remembers the pending
   authorization, and returns the issuer URL; the panel assigns
   `window.location`.
3. The issuer signs the person in and redirects to the Browser's callback
   page, `/:locale/auth/callback`.
4. The callback page calls `semiont.completeSignIn(window.location.href)`,
   which exchanges the authorization code (PKCE) for the access and refresh
   pair, asks the KB who it is, and signs in the entry for the KB that
   answered.

## Cross-tree session signaling

Auth failures originate in the transport, which lives outside the React
tree and cannot call hooks. The transport stamps each failure with a
`TransportErrorCode` and republishes it on `session.errors$`. The
`SemiontBrowser` singleton subscribes to the active session's error
stream and routes failures to that session's `SessionSignals`:

```typescript
// SemiontBrowser, on session activation (packages/sdk/src/session/semiont-browser.ts)
declare const signals: SessionSignals; // the session's signals

session.errors$.subscribe((err) => {
  if (err.code === 'unauthorized') void session.refresh();
  else if (err.code === 'forbidden') signals.notifyPermissionDenied(err.message);
});
```

A `401` is not the end of a session: `refresh()` renews the token, and only a
session that cannot be renewed, or whose renewed token the knowledge base also
refuses, ends. The session's own `onAuthFailed` then raises `notifySessionEnded`
with why: `expired` or `refused`. A `403` raises `notifyPermissionDenied` with
the refusal's message as its detail.

`SessionSignals` exposes the modal state as `BehaviorSubject`s
(`sessionEnded$`, `permissionDenied$`, …), surfaced by the browser
as `activeSignals$`. `SessionEndedModal` and `PermissionDeniedModal`
subscribe to it via `useObservable` — so a failure raised entirely
outside React still drives the UI.

When no session is active (e.g. on the landing page), `activeSignals$` is
`null`, so nothing is raised.

## Testing

See [tests/e2e/specs/07-sign-out-sign-in.spec.ts](../../../tests/e2e/specs/07-sign-out-sign-in.spec.ts)
for the end-to-end guard: sign out, sign back in through the
issuer, confirm the new session's bus/SSE/client round-trip. The test gates
on the KB row's sign-out control reappearing rather than URL matching,
because `toHaveURL(/know/)` passes immediately post-sign-out (the URL already
matches), and a subsequent `page.goto` would abort the still-in-flight
callback.

## Related

- [SESSION.md (`@semiont/react-ui`)](../../../docs/builder/react-ui/SESSION.md)
  — class model, observables, invariants.
- [EVENTS.md (`@semiont/react-ui`)](../../../docs/builder/react-ui/EVENTS.md)
  — bus architecture, channel routing.
- [AUTHORIZATION.md](./AUTHORIZATION.md) — permission model.
