# Session internals

What the session layer is and how a React app uses it is in the builder docs:
[SESSION.md](../../../docs/builder/react-ui/SESSION.md). This page holds the
file layout and the invariants the implementation keeps.

## Package layout

```text
@semiont/sdk
├── client.ts                    ← SemiontClient (transport + its EventBus)
├── session/                     ← per-KB session, app-level browser, storage
│   ├── session-storage.ts       ← SessionStorage interface + InMemorySessionStorage
│   ├── semiont-session.ts       ← SemiontSession (per-KB)
│   ├── semiont-browser.ts       ← SemiontBrowser (app singleton)
│   ├── session-signals.ts       ← SessionSignals (the modals' state)
│   ├── session-factory.ts       ← SessionFactory type
│   ├── http-session-factory.ts  ← createHttpSessionFactory()
│   ├── registry.ts              ← getBrowser({ storage, sessionFactory }) singleton
│   ├── oauth.ts                 ← issuer discovery, PKCE / device grants, refresh, revoke
│   ├── connect.ts               ← what a completed sign-in learns about the KB
│   ├── storage.ts               ← pure helpers + adapter-fed loaders
│   ├── errors.ts                ← SemiontSessionError
│   ├── knowledge-base.ts        ← KnowledgeBase, KbSessionStatus types
│   └── open-resource.ts         ← OpenResource type
└── state/                       ← state-unit factories; take `client`, not a bus
    ├── flows/                   ← beckon, gather, mark, match, yield
    └── lib/                     ← createDisposer, search pipeline

@semiont/react-ui
├── session/
│   ├── SemiontProvider.tsx      ← React context provider + useSemiont hook
│   └── web-browser-storage.ts   ← WebBrowserStorage (localStorage + storage event)
└── state/
    └── shell-state-unit.ts      ← ShellStateUnit (toolbar panel state)
```

No session logic lives in `@semiont/react-ui`. Its session surface is
`SemiontProvider` / `useSemiont` (context) and `WebBrowserStorage` (the
browser-backed `SessionStorage` implementation).

## Invariants

1. **One client per KB.** The session owns it; the browser owns the
   session; `setActiveKb` is the only path to swap.
2. **Session classes are environment-agnostic.** No `window` or
   `localStorage` references. Storage goes through `SessionStorage`.
3. **The browser's bus is private; the client's is read-only.** Shell
   traffic goes through `browser.emit` / `.on` / `.stream`; session
   traffic through the client's typed namespace methods, `client.bus`,
   or `session.subscribe`.
4. **State-unit factories never construct an `EventBus`.** They take the
   client or browser that owns one.
5. **Every channel belongs to exactly one bus.** `EventMap` in
   `@semiont/core/bus-protocol.ts` is the source of truth. Don't
   split a channel across buses; don't emit to both.
6. **`sessionActivating$` is the only valid loading indicator.** UIs
   that want to show a spinner while the session is under
   construction must AND-gate on `sessionActivating$`; otherwise
   they get stuck spinning after `signOut`.
7. **React layer is provider + hook only.** All session types live in
   `@semiont/sdk`; the React package's session surface is `SemiontProvider`,
   `useSemiont`, and `WebBrowserStorage`.
