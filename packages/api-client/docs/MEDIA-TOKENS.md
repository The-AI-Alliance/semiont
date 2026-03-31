# Media Tokens

Binary resources (images, PDFs, and any other non-text content) cannot be fetched with an `Authorization` header by browser-native elements (`<img src>`, PDF.js URL loading). Media tokens solve this without buffering entire files into the JS heap.

## What is a media token

A media token is a short-lived JWT with:

| Claim | Value |
|---|---|
| `purpose` | `'media'` |
| `sub` | `resourceId` (scoped to exactly one resource) |
| `exp` | 5 minutes from issuance |
| `userId` | for audit |

Signed with the same `JWT_SECRET` as session tokens. No backend state — validation is pure crypto.

The token is appended as a query parameter: `?token=<media-token>`. The backend validates it on resource endpoints and accepts it in place of a session cookie or Bearer token.

## Client API

```typescript
const { token } = await client.getMediaToken(resourceId, { auth: accessToken(myToken) });
const url = `${client.baseUrl}/api/resources/${resourceId}?token=${token}`;
// Pass url to <img src>, pdfjsLib.getDocument({ url }), etc.
```

`getMediaToken` calls `POST /api/tokens/media` with the resource ID and returns `{ token: string }`.

## React hook

`useMediaToken` from `@semiont/react-ui` is the React Query wrapper:

```typescript
import { useMediaToken } from '@semiont/react-ui';

const { token, loading } = useMediaToken(resourceId);
```

- `staleTime`: 4 minutes — ensures the token is refreshed before the 5-minute expiry
- The hook is per-resource; each resource has its own React Query cache entry
- `token` is `undefined` while loading

`ResourceViewerPage` in `@semiont/react-ui` calls this hook automatically for any resource whose `getMimeCategory` returns `'image'` (which includes `application/pdf`). Callers of `ResourceViewerPage` do not need to manage media tokens directly.

## Data flow for binary resources

```
ResourceViewerPage
  → useMediaToken(resourceId)
      → POST /api/tokens/media  (Bearer/cookie auth, once per 4 min)
      → { token }
  → resourceUrl = `${baseUrl}/api/resources/${id}?token=${token}`
  → passes resourceUrl to viewer component
  → <img src={resourceUrl}> or pdfjsLib.getDocument({ url: resourceUrl })
      → browser/PDF.js fetches directly, streams, no ArrayBuffer in JS
```

Text resources (`text/plain`, `text/markdown`) are fetched through `useResourceContent`, which uses the authenticated representation endpoint and decodes the response to a string. They do not use media tokens.

## Why not observable stores

Media tokens are intentionally not in the observable stores (`ResourceStore`, `AnnotationStore`). They are short-lived, non-domain state — there is no EventBus event for token expiry, and storing them reactively would add complexity with no benefit. React Query's `staleTime`-based refresh is the right fit.

## OpenAPI spec

`POST /api/tokens/media` is specified in `specs/src/paths/api_tokens_media.json`. The request schema is `MediaTokenRequest` (`{ resourceId: string }`) and the response is `MediaTokenResponse` (`{ token: string }`).
