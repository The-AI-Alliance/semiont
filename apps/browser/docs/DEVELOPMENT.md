# Browser Development

How to work on the Semiont Browser: running it from source against a real stack, the scripts
it has, adding a page, and where to look when something is wrong.

Building the whole monorepo, and running your changes as the shipped images, is the
contributor's [Local Development](../../../docs/contributor/LOCAL-DEVELOPMENT.md). This page is
what is particular to this app.

## Run it from source against a stack

The Browser is a client, so it needs a knowledge base to talk to. Start one with the
[`semiont` launcher](../../launcher/README.md), from a knowledge base's directory, and then
serve the app from source in place of the stack's own Browser.

```bash
# In a knowledge base's directory
semiont start
semiont useradd --email you@example.com   # prompts for the password
semiont stop --service browser            # free port 3000 for the dev server
```

```bash
# In this repository
cd apps/browser
npm run dev                               # Vite on http://localhost:3000, with hot reload
```

Open <http://localhost:3000>, add the knowledge base in the Knowledge Bases panel (`http`,
`localhost`, `4000`), and sign in.

**The dev server must take the Browser's own port.** Sign-in is a cross-origin exchange with the
knowledge base's identity provider, which accepts it only from the origin it was told the
Browser is at, port included. That is why the stack's Browser is stopped first rather than left
running beside the dev server. A stack whose Browser was moved with
`semiont start --service browser --port <n>` expects that port instead.

**The dev server lists no running stacks.** The "found on this machine" list comes from
`/discovery/*`, which only `server.js` serves, from a directory the launcher mounts into the
container. Under Vite, add the knowledge base by hand.

## Run it as the shipped container

When a change needs to be exercised as the image, or it touches a package a service runs,
rebuild with [`scripts/ci/local-build.sh`](../../../scripts/ci/local-build.sh) and start the
stack with `SEMIONT_VERSION=local`. Without that variable the launcher runs the published
images and your change is not in them. [Local Development](../../../docs/contributor/LOCAL-DEVELOPMENT.md)
has the loop.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | The Vite dev server, on port 3000 |
| `npm run build` | Typecheck, then `vite build` into `dist/` |
| `npm run build:quick` | `vite build` alone |
| `npm start` | `vite preview`: serves the built `dist/` on port 3000 |
| `npm run typecheck` | `tsc --noEmit` over the app |
| `npm run typecheck:test` | The same over the tests |
| `npm test` | The suite, once |
| `npm run test:watch` | The suite, watching |
| `npm run test:coverage` | The suite, with coverage |
| `npm run test:security` | The tests of the protected layout's session gates and of the locale layout |
| `npm run test:a11y` | The accessibility tests |

Translations are generated before `dev`, `build`, `start` and the test scripts run:
`scripts/merge-translations.js` merges `messages-source/` with `@semiont/react-ui`'s strings
into `messages/` and `public/messages/`. Edit `messages-source/`, never the generated
directories ([Internationalization](./INTERNATIONALIZATION.md)).

How the tests are written is [Testing](./TESTING.md).

## Adding a page

Pages are not discovered from the file tree. A page is a component under `src/app/[locale]/`
and a route registered for it in `src/App.tsx`.

**1. Write the page**, one directory per route:

```tsx sketch
// src/app/[locale]/know/timeline/page.tsx
import { useSemiont, useObservable } from '@semiont/react-ui';

export default function TimelinePage() {
  const session = useObservable(useSemiont().activeSession$);
  const state = useObservable(session?.client.browse.entityTypes());

  if (!state || state.status === 'pending') return <p>Loading…</p>;
  if (state.status === 'failed') return <p role="alert">{state.error.message}</p>;
  return <ul>{state.value.map((t) => <li key={t}>{t}</li>)}</ul>;
}
```

**2. Register its route** in `src/App.tsx`, as a `React.lazy` import and a `<Route>` under the
layout it belongs to:

```tsx sketch
const TimelinePage = React.lazy(() => import('./app/[locale]/know/timeline/page'));

// inside the `know` route, which is inside ProtectedLayout:
<Route path="timeline" element={<TimelinePage />} />
```

A page that needs a signed-in person goes under `ProtectedLayout`, the pathless route that
mounts `AuthShell` around `know/` and `moderate/`. There is no per-page guard to write: the
section's layout decides between its signed-in and signed-out views
([Authentication](./AUTHENTICATION.md#route-protection-pattern)).

A page reads and writes through the session's client and nothing else. The app contains no
`fetch` call. [API Integration](./API-INTEGRATION.md) has the client's namespaces and how live
queries refresh themselves.

A component that could serve another host application belongs in `@semiont/react-ui`, not
here. This app holds routes, providers and the few components that make sense nowhere else
([Component Library](./COMPONENT-LIBRARY.md)).

## Styles

`src/app/globals.css` imports `@semiont/react-ui/styles` and then Tailwind:

- **`@semiont/react-ui`'s semantic classes** style every library component. Do not override
  them from the app.
- **Tailwind utilities** are for this app's own layout: page containers, spacing, positioning.

```tsx
import { Button } from '@semiont/react-ui';

// Good: spacing around a library component
<Button variant="primary" className="mt-4">Submit</Button>;
```

Dark mode is one switch for both. The theme provider sets `data-theme` on the root element,
react-ui's tokens follow it, and Tailwind's `dark:` variant is configured to follow the same
attribute (`tailwind.config.js`).

The patterns are in the [Style Guide](./style-guide.md), and the tokens and classes in
react-ui's [Styles](../../../docs/builder/react-ui/STYLES.md).

## When something is wrong

- **See the bus.** In the page's console, `window.__SEMIONT_BUS_LOG__ = true` logs one line for
  every bus event the page sends and receives. It is usually the fastest way to see what a
  change did ([bus logging](../../../tests/e2e/docs/bus-logging.md)).
- **Who am I signed in as?** `GET /api/users/me` on the gateway, with the session's token,
  answers the DID every event is attributed to.
- **Sign-in fails.** Look at the identity provider's logs, not the gateway's: a sign-in that
  fails never reaches the gateway. An `Invalid origin` there means the app is not running at
  the origin the provider expects, which is the port rule above.
- **Signed out on reload.** The session is in `localStorage`, under `semiont.session.<kb id>`.
  If it is there and the app still shows signed out, the provider refused to renew it.
- **Requests are blocked as mixed content.** An app loaded over `https` cannot call a gateway
  over `http`.
- **Changes do not show up.** Check the console for a syntax error, restart `npm run dev`,
  and clear Vite's cache with `rm -rf node_modules/.vite`.
- **`npm run build` fails.** Run `npm run typecheck` for the error.

## Related

- [Architecture](./ARCHITECTURE.md): how the app is built
- [Authentication](./AUTHENTICATION.md): sessions, sign-in, route protection
- [Testing](./TESTING.md): how the tests are written and run
- [Container](./CONTAINER.md): the image
- [Local Development](../../../docs/contributor/LOCAL-DEVELOPMENT.md): the monorepo's loop
- [The launcher](../../launcher/README.md): every verb and flag
