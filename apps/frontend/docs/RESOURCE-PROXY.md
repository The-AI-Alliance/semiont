# Authenticated Media Access

> **Heads-up on the filename.** This doc used to describe a Next.js server-side
> *proxy route* (`/api/resources/[id]`). That route is **gone** — the frontend
> is now a pure Vite + React SPA (#557) with **no server**, and auth is
> **bearer-only** (#890). There is nothing to proxy through. The live mechanism
> is the **`?token=` media token** documented here; the `RESOURCE-PROXY` filename
> is kept only so inbound links don't break.

## The problem: header-less elements can't authenticate

Semiont's backend is **bearer-only** — every request must carry
`Authorization: Bearer <jwt>`, and there are **no ambient credentials** —
nothing the browser attaches automatically, no cookie of any kind. That's a problem
for the elements that load binary content, because they **cannot set request
headers**:

```html
<!-- ❌ No way to attach Authorization: Bearer on an <img> -->
<img src="https://backend.example.com/api/resources/123" />
```

```typescript
// ❌ PDF.js fetches by URL and likewise cannot add an Authorization header
const pdf = await pdfjsLib.getDocument({
  url: 'https://backend.example.com/api/resources/123',
}).promise;
```

`<img>`, `<iframe>`, `<video>`, `<embed>`, and PDF.js URL-loading all send only
the browser's standard headers. With no cookie to fall back on (bearer-only),
they can't reach a protected resource on their own.

## The solution: a short-lived, resource-scoped token on the URL

The frontend mints a **media token** — a narrowed credential the browser *can*
carry, because it rides on the URL as a query parameter rather than in a header:

```typescript
const { token } = await client.auth.mediaToken(resourceId);
const url = `${client.baseUrl}/api/resources/${resourceId}?token=${token}`;
// Hand `url` to <img src>, pdfjsLib.getDocument({ url }), etc.
```

`auth.mediaToken` calls `POST /api/tokens/media` (itself authenticated with the
session's bearer token) and returns `{ token }`. The token is a JWT scoped to
**exactly one resource** (`sub: resourceId`) and expiring in **5 minutes**. The
backend accepts it on `GET /api/resources/:id` in place of the `Authorization`
header.

**This preserves authentication — it doesn't bypass it.** Getting a media token
requires a valid session. The full claim format, validation, and OpenAPI spec
live in the canonical
[`@semiont/http-transport` MEDIA-TOKENS.md](../../../packages/http-transport/docs/MEDIA-TOKENS.md);
this doc covers how the SPA uses it.

### Isn't a token in the URL a security hole?

A *session* token in a URL would be — query strings leak into proxy logs,
browser history, and `Referer` headers, and a leaked session token grants the
attacker hours of full access. A **media token's blast radius is tiny**:
5 minutes × one specific resource. The `sub: resourceId` claim is the
load-bearing safety property — a leaked media token is cryptographically useless
against any *other* resource, even one the same user could open with their
session token. That scoping is exactly why putting it on the URL is acceptable
where putting a session token there would not be. See the **Threat model**
section of [MEDIA-TOKENS.md](../../../packages/http-transport/docs/MEDIA-TOKENS.md).

## React usage

Components don't manage tokens by hand. The `useMediaToken` hook from
`@semiont/react-ui` fetches a token on mount and refreshes it every **4 minutes**
— ahead of the 5-minute expiry, so an in-flight load never races the rollover:

```typescript
import { useMediaToken } from '@semiont/react-ui';

const { token, loading } = useMediaToken(resourceId);
const src = token ? `${baseUrl}/api/resources/${resourceId}?token=${token}` : undefined;
```

`ResourceViewerPage` calls this automatically for any resource whose media type
renders as an image (which includes `application/pdf`), so callers of
`ResourceViewerPage` get authenticated `<img>`/PDF rendering for free.

## Data flow for binary resources

```
ResourceViewerPage
  → useMediaToken(resourceId)
      → POST /api/tokens/media   (bearer-authenticated, once per 4 min)
      → { token }
  → resourceUrl = `${baseUrl}/api/resources/${id}?token=${token}`
  → passes resourceUrl to the viewer component
  → <img src={resourceUrl}>  or  pdfjsLib.getDocument({ url: resourceUrl })
      → browser / PDF.js fetches directly and streams — no ArrayBuffer in JS
```

Streaming directly through the browser (rather than buffering the bytes into the
JS heap) keeps large files — multi-MB images, tens-of-MB PDFs — off the main
thread and preserves progressive rendering and HTTP cache participation.

## Text resources don't use media tokens

The split is **display vs programmatic**, not text vs binary:

- **Text** (`text/plain`, `text/markdown`, …) is fetched by `useResourceContent`
  through the authenticated representation endpoint and decoded to a string —
  a normal bearer-authenticated request, no media token.
- **Binary display** (`<img>`, PDF.js) uses media tokens, as above.
- **Non-browser consumers** (CLI, daemon, MCP server) never need a media token:
  they read binary content through `IContentTransport.getBinary` with normal
  `Authorization` headers, and upload through `client.yield.resource(...)` /
  `IContentTransport.putBinary`. Media tokens are read-path-only and browser-only.

## Related documentation

- [`@semiont/http-transport` MEDIA-TOKENS.md](../../../packages/http-transport/docs/MEDIA-TOKENS.md) — the canonical media-token spec (claims, threat model, OpenAPI)
- [Frontend Authentication Architecture](./AUTHENTICATION.md) — the SPA's bearer-only session model
- [Backend Authentication Guide](../../backend/docs/AUTHENTICATION.md) — JWT validation, including the `?token=` media path
- [System Authentication Architecture](../../../docs/system/administration/AUTHENTICATION.md) — end-to-end auth flows

---

**Last Updated**: 2026-06-20
**Key implementation**:
- `packages/react-ui/src/hooks/useMediaToken.ts` — the refreshing token hook
- `packages/react-ui/src/features/resource-viewer/components/ResourceViewerPage.tsx` — builds the `?token=` URL for binary resources
- `packages/sdk/src/namespaces/auth.ts` — `auth.mediaToken()` → `POST /api/tokens/media`
- `packages/react-ui/src/lib/browser-pdfjs.ts` — PDF.js loader that consumes the `?token=` URL
