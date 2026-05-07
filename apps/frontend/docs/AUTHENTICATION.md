# Frontend Authentication Architecture

## Overview

A user is always authenticated **against a specific Knowledge Base
(KB)** — never globally. Switching KBs means switching sessions
atomically. The frontend stores one JWT pair per KB in
`localStorage` and validates on session construction via the backend's
`GET /api/users/me` endpoint.

There is no NextAuth, no httpOnly cookie, no global session. Session
state is owned by a single `SemiontBrowser` singleton that lives in
`@semiont/api-client` and is exposed to React via the
`SemiontProvider` + `useSemiont()` pair in `@semiont/react-ui`.

For the class-level story (observables, lifetimes, invariants), see
[SESSION.md in `@semiont/react-ui`](../../../packages/react-ui/docs/SESSION.md).
This doc covers the **frontend-app** concerns: where providers mount,
how route protection is expressed, how sign-in / sign-out flow, and
how out-of-tree code signals the provider.

## Core pieces

### `SemiontBrowser` (singleton)

App-level container owning the KB list, active selection, session,
open-resources tab state, identity token, and two event buses. Lives
in `@semiont/api-client` so CLI / MCP / workers can use it too.

Key observables the UI reads:

- `kbs$` — configured KB list
- `activeKbId$` — currently selected KB (set, even when signed out)
- `activeSession$` — live `SemiontSession | null`
- `sessionActivating$` — true while `setActiveKb` / `signIn` is in
  flight awaiting `session.ready`. **The only valid loading
  indicator.** UIs that want a spinner during session construction
  must AND-gate on this, otherwise they stick on the spinner
  forever after sign-out (see [Sign-out semantics](#sign-out-semantics)).
- `openResources$`, `identityToken$`, `error$`

### `SemiontProvider` + `useSemiont()` (React surface)

The only React export that touches session state. Mount once at the
app root — not only inside protected routes. The provider is cheap;
zero-KB and signed-out are first-class states, not pre-app states.

```tsx
import { SemiontProvider } from '@semiont/react-ui';

export default function AppLayout({ children }) {
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

  if (!user) return <SignInPrompt />;
  return <div>Hello, {user.name}</div>;
}
```

`useSemiont()` throws if no `SemiontProvider` is mounted. There is no
fallback — auth misuse must fail loudly.

### `KnowledgeBasePanel` (UI)

User-facing UI for adding / switching / signing out of KBs. Calls
`browser.addKb(input)`, `browser.signIn(id, access, refresh)`, and
`browser.signOut(id)`. Never writes to `localStorage` directly — all
persistence goes through `SemiontBrowser`'s `SessionStorage` adapter
(the frontend injects `WebBrowserStorage`).

## Route protection pattern

A protected layout reads three observables and branches on three
states. The order matters:

```tsx
function KnowledgeLayoutBody() {
  const semiont = useSemiont();
  const activeKbId = useObservable(semiont.activeKbId$);
  const session = useObservable(semiont.activeSession$);
  const sessionActivating = useObservable(semiont.sessionActivating$);
  const token = useObservable(session?.token$);
  const activeKnowledgeBase = session?.kb ?? null;

  // 1. Session under construction — brief, shown only during active activation.
  const isLoading = activeKbId != null && session == null && sessionActivating;
  if (isLoading) return <LoadingSpinner />;

  // 2. Unauth — active KB exists but no session (signed out, or no credentials).
  if (!activeKnowledgeBase || !token) return <UnauthenticatedKnowledgeLayout />;

  // 3. Authed.
  return <AuthenticatedKnowledgeLayout />;
}
```

The AND-gate on `sessionActivating` is load-bearing. Without it,
every `signOut` leaves the layout stuck on the spinner forever —
`activeKbId` is still set, `session` is null, and there's nothing to
arrive.

## Sign-out semantics

Calling `browser.signOut(id)` does **two things, not three**:

1. Clears stored tokens for that KB from storage.
2. If the KB is active: disposes the `SemiontSession` and emits
   `null` on `activeSession$`.

It deliberately does **not** clear `activeKbId$`. Per the app's
design: "all KB entries are shown, one is active, regardless of
whether the auth is current." Sign-out is a credentials concept, not
a selection concept.

The resulting state (active KB set, session null, `sessionActivating`
false) is how the layout knows to render the unauth view with a
"signed out, click the KB to re-auth" affordance.

## Authentication flow

```
1. User adds a KB via KnowledgeBasePanel
   └── Frontend POSTs credentials directly to that KB's backend
       └── Backend returns access + refresh JWTs
           └── Panel calls browser.addKb({...kb}) and browser.signIn(id, access, refresh)
               └── Browser stores tokens, activates the KB, constructs a SemiontSession

2. Page mount with existing stored tokens (reload, new tab)
   └── SemiontBrowser constructor reads activeKbId from storage
       └── Kicks off setActiveKb(id), sessionActivating$ → true
           └── SemiontSession constructs, validates token via /api/users/me
               ├── 200 → activeSession$.next(session), sessionActivating$ → false
               └── 401 → session disposes itself, activeSession$ stays null,
                         session fires sessionExpiredAt$ on the dead session (see below)

3. Out-of-band 401/403 from any HTTP / bus call
   └── QueryCache.onError (or similar) → notifySessionExpired() / notifyPermissionDenied()
       └── Module-level notify calls into the active session's modal flags
           └── Modal reads the flag via useObservable and surfaces

4. Sign out
   └── User clicks per-KB sign-out in KnowledgeBasePanel
       └── browser.signOut(id) — clears tokens, disposes session
           └── activeKbId$ stays set; layout drops into UnauthenticatedKnowledgeLayout
```

## OAuth flow

OAuth providers can be configured per KB on the backend. The flow:

1. User picks a KB and an OAuth provider in the connect form.
2. Browser redirects to the backend's OAuth endpoint for that KB.
3. Backend handles the OAuth dance, issues a JWT, redirects back with
   the token in the URL fragment.
4. Frontend parses the fragment, calls `browser.signIn(id, ...)` with
   the returned tokens.

## Cross-tree session signaling

Code outside the React tree (React Query `QueryCache.onError`,
`MutationCache.onError`, etc.) cannot call hooks. It signals the
active session via module-scoped notify functions registered at
provider mount:

```typescript
import { notifySessionExpired, notifyPermissionDenied } from '@semiont/react-ui';

new QueryCache({
  onError: (error) => {
    if (error instanceof APIError) {
      if (error.status === 401) notifySessionExpired('Your session has expired.');
      if (error.status === 403) notifyPermissionDenied('Access denied.');
    }
  },
});
```

When no `SemiontProvider` is mounted (e.g. on the landing page),
these calls are no-ops — the `SemiontBrowser`'s notify-handler
registration happens in the provider's effect, so absent provider,
no handler is registered.

## Testing

See [tests/e2e/specs/07-sign-out-sign-in.spec.ts](../../../tests/e2e/specs/07-sign-out-sign-in.spec.ts)
for the end-to-end regression guard: sign out, sign back in, confirm
the new session's bus/SSE/client round-trip. The test gates on the
password form disappearing rather than URL matching, because
`toHaveURL(/know/)` passes immediately post-sign-out (the URL already
matches), and a subsequent `page.goto` would abort the in-flight
sign-in POST.

## Related

- [SESSION.md (`@semiont/react-ui`)](../../../packages/react-ui/docs/SESSION.md)
  — class model, observables, invariants.
- [EVENTS.md (`@semiont/react-ui`)](../../../packages/react-ui/docs/EVENTS.md)
  — bus architecture, channel routing.
- [AUTHORIZATION.md](./AUTHORIZATION.md) — permission model.
