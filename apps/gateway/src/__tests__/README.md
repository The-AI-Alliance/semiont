# Gateway Tests

## The primary security contract

`route-spec-coverage.test.ts` is the gate that matters. It walks every route the
gateway registers and requires each one to either return 401 to an
unauthenticated caller or be declared public in the OpenAPI spec. The spec is the
single source of truth for which routes are public, so a new protected route is
enrolled in the check by existing, not by anyone remembering to add it to a list.

`security-controls.test.ts` covers the controls that are not per-route: security
headers, error-response shape, and payload limits.

## Authentication and identity

- `auth/jwt.test.ts` — gateway-minted token generation, validation, expiry, and
  the signing-key ring used during rotation
- `identity/*.test.ts` — issuer token verification against the issuer's published
  keys, user provisioning, the Keycloak admin client, and the gateway-token path
- `middleware/auth.test.ts` — bearer extraction, the media-token query path, and
  what the middleware puts on the request context

There is no administration surface on the gateway. Accounts are administered at
the knowledge base's identity provider, so there are no admin endpoints to
protect and no admin middleware to test.

## Running

```bash
npm test                                      # everything
npm test -- route-spec-coverage.test.ts       # the route auth contract
npm test -- identity/                         # issuer verification + provisioning
npm test -- --coverage
```

## Maintenance

Re-run these before changing the auth middleware (`src/middleware/auth.ts`),
anything under `src/identity/`, or the `security` field of any operation in
`specs/src/paths/` — that field is what decides whether a route is allowed to
answer an unauthenticated caller.
