# Authentication

Semiont uses **bearer-only** authentication: every request authenticates with an `Authorization: Bearer` JWT (or, for media, a short-lived `?token=`). There are **no session cookies** — the gateway carries no ambient credentials, which is what lets CORS be fully open (`*`) and a KB be hosted on the public internet.

See also [Security](./SECURITY.md) for what Semiont enforces and what it leaves to the issuer and the platform, [Secrets](../services/SECRETS.md) for how secrets reach services, and [Configuration](./CONFIGURATION.md#the-issuer) for how a knowledge base names the issuer it trusts.

## Overview

Three pieces make up the auth system:

1. **Sign-in happens elsewhere.** People authenticate at the knowledge base's trusted issuer and receive a token from it. The gateway mints no human credential and holds no password; it is a resource server, not an auth server.
2. **Bearer validation** — the gateway validates the token on every protected request, verifying an issuer token against the issuer's published keys and building the caller's principal from the claims it carries. There is no directory to consult: the identity is the token.
3. **Revocation belongs to the issuer.** Disabling an account there stops new tokens at once. A token already issued stays valid until it expires, and that lifetime is the revocation window.

## Authentication Flow Diagram

```mermaid
graph TB
    subgraph "Client (SPA / SDK / CLI)"
        App[App holds its tokens]
    end

    subgraph "Trusted Issuer"
        IdP[Identity provider<br/>owns credentials and accounts]
        JWKS[Published signing keys]
    end

    subgraph "Gateway API"
        TokenGen[Agent and media token mint]
        MW[Token verification<br/>Bearer, or ?token= for media]
        Principal[Principal<br/>DID, email, name, domain]
        API[Protected APIs]
    end

    App -->|"1. sign in"| IdP
    IdP -.->|"2. access token"| App

    App -->|"3. Authorization: Bearer <token>"| MW
    MW -->|"4. verify signature against"| JWKS
    MW -->|"5. derive from the token's own claims"| Principal
    Principal --> API
    App -->|"6. POST /api/tokens/media (resource-scoped)"| TokenGen
```

No datastore appears in that diagram, and that is the point: step 5 reads the
token, not a table; the PostgreSQL in a stack is Keycloak's — see
[Database](./DATABASE.md).

## Authentication Model

### Core principles

- **Bearer-only**: authentication is an `Authorization: Bearer <jwt>` header. JS attaches it explicitly — it is **not** an ambient credential, so the API works with CORS `origin: '*'` and no `Access-Control-Allow-Credentials` (see [Security](./SECURITY.md)).
- **Protection is per route**: each route's handler names the credential it needs, and nothing is protected by default.
- **Stateless, with no per-request lookup**: the principal is derived from the token's claims on every request. A display-name change at the issuer reaches the gateway when the holder's next token is minted, not before — there is no row to update and nothing cached to invalidate. The gateway records that name on the knowledge base's log the next time its holder **acts**, so the record can say who a DID belongs to; someone who signs in and only reads is never named there.
- **One admission decision, held by the issuer**: the gateway admits every subject whose token verifies. It keeps no allowlist and no per-user enable flag, because a second answer to "may this person sign in" can only disagree with the first — and only the issuer's answer can stop a token being minted.

### Token lifecycle

| Token | TTL | Carried as | Purpose |
|---|---|---|---|
| **Access** | **5 minutes** | `Authorization: Bearer` | Per-request API auth for people; minted by the issuer, validated here on every protected route. This is the revocation window: a disabled account's token works until it expires. |
| **Agent** | **1 hour** | `Authorization: Bearer` | Software-agent identity for background workers (`/api/tokens/agent`). No account exists at the issuer to disable, so this lifetime is the whole of the revocation window. |
| **Media** | 5 minutes | `?token=` query param | Resource-scoped token for `GET /api/resources/:id` (images, PDFs) where a header can't be set. |

This table is the only place these values are written down; everywhere else says
"short-lived" and links here. Each one is one `grep` from its mint site — check a
row against the literal, not against another document:

| Token | Minted at | Literal |
|---|---|---|
| Access | the realm the launcher imports, [`packages/go/launcher/identity.go`](../../../packages/go/launcher/identity.go) | `keycloakAccessTokenLifespan`, which `semiont init` writes into the Issuer document as `spec.accessTokenLifespan`, and the launcher into the realm as `accessTokenLifespan`. A knowledge base changes it in its Issuer document. **Applied only on first boot** — import skips an existing realm, which keeps what it was created with, and `semiont start` warns when the realm's actual lifespan disagrees with the document. |
| Agent | [`images/gateway/src/tokens.rs`](../../../images/gateway/src/tokens.rs) | `AGENT_TOKEN_SECONDS`, the one named constant; holders read `exp` off the token rather than restating it |
| Media | [`images/gateway/src/tokens.rs`](../../../images/gateway/src/tokens.rs) | `MEDIA_TOKEN_SECONDS` (five minutes) |

### Revocation

**Disable the account at the issuer.** It stops minting for that person immediately, which ends their access as soon as the token they are holding expires.

That delay is the whole of the trade, and it is deliberate: one system answers who may act, so nothing can disagree with the issuer, and the access token lifetime above bounds how long a disabled person can still act.

Disabling also stops the refresh grant, so the person cannot mint a replacement when the one they hold expires.

**Signing out is between the client and the issuer.** The client revokes its refresh token at the issuer (RFC 7009) and drops the access token it holds. The gateway is not told and keeps nothing to change; an access token already issued works until it expires.

**Agent tokens are the exception with no issuer behind them.** An agent identity is synthetic — derived from a (provider, model) pair rather than registered anywhere — so there is no account to disable. Its lifetime is the whole of its revocation window. Disabling at the issuer the *service account* that asked for it stops further mints, but cannot touch a token already handed out.

## Who a person is, and who vouches for it

### The subject claim

`spec.issuer.subjectClaim`, in the knowledge base's `knowledge-base.yaml`, names the issuer claim a person's DID is built from: `sub`, as `semiont init` writes it, is the issuer's stable identifier, and `email` names people by address.

It is required — the KnowledgeBase schema refuses a document without it, and the gateway refuses a configuration without it, naming the key — and it has no default: which claim identifies a person is declared per deployment, never inferred. The DID is `did:web:<site domain>:users:<claim value>`, under the same `site.domain` the deployment mints its software agents beneath, so a person and the software working for them are peers under one authority. With `"sub"`, a changed email changes nothing about who authored what; with `"email"`, the address is the identity, and the operator has said so.

### The trust boundary

The gateway, the services behind it, and the administrator who runs them and commits the event log are **one party**. The gateway verifies every bearer token and stamps the verified DID onto every event as `_userId`; nothing behind it re-verifies, because there is nothing to gain — from outside, this knowledge base vouched for its log either way. What the record holds is therefore the knowledge base's word: every provenance fact on an artifact is either the verified emitter of an event or derived by joining events whose emitters were verified, and nothing an emitter asserts about identity in a payload is honoured. Verification of that log by a reader *outside* the knowledge base — a signature under a key the emitter controls — is not a property a single deployment has; it belongs to federation between knowledge bases, where each signs what it vouches for.

## Endpoint Protection

### Public endpoints (no auth)

- `GET /api/health` and `GET /` — health check
- `GET /.well-known/oauth-protected-resource` — names the issuer this deployment trusts (RFC 9728)
- `GET /api/openapi.json` — the OpenAPI document itself

That is the complete list. The OpenAPI spec is the single source of truth for it — an operation declaring `"security": []` is public — and the gateway conformance suite (`tests/conformance`) probes every operation the spec declares, failing if a protected one answers an unauthenticated caller with anything but 401.

There is no password endpoint, no provider endpoint and no refresh endpoint. People obtain tokens from the issuer.

### Service-account endpoint

`POST /api/tokens/agent` is **not** public. A sidecar authenticates at the issuer as its own service account, presents that token here as a bearer, and receives a software-agent token naming a (provider, model) identity. The gateway verifies the bearer against the issuer's keys and requires a flat `roles` claim containing `semiont-service`; every refusal is a 401, checked *before* the body is parsed.

Two identities, deliberately: the service account is the **process**, the agent DID is the **work**. One worker holds several agent identities at once when a deployment configures different models for different jobs, so the caller's credential cannot be the agent's identity.

### Protected endpoints

Require a valid `Authorization: Bearer` access token. Examples: `GET /api/users/me`, `GET /api/status`, `POST /api/tokens/media`, the bus endpoints, and all of `/api/resources/*`.

```http
GET /api/users/me HTTP/1.1
Host: kb.example.com
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

`GET /api/users/me` answers with the caller's **DID**, which is the name the rest of the system
uses for them: the bus stamps it on every event, resource creation is attributed to it, and the
signal ledger claims under it. A client compares against this to recognise its own work in the
data.

### Media tokens (`?token=`)

`GET /api/resources/:id` additionally accepts a short-lived, resource-scoped **media token** as `?token=` (minted by `POST /api/tokens/media`), checked **before** the `Authorization` header. This is the path `<img>` / PDF / media use, where a request header can't be set. It is the *only* `?token=` path — it does not apply to the bare `/resources/:id` IRI.

### Bare-IRI navigation → 401

A raw browser navigation to a protected resource (e.g. pasting a `/resources/:id` IRI) is unauthenticated and returns **401** — there is no cookie and no login redirect. The missing-token 401 carries an actionable `hint`:

```json
{
  "error": "Unauthorized",
  "hint": "Authentication required: send an `Authorization: Bearer <token>` header. A raw browser navigation to a protected resource is unauthenticated."
}
```

The IRI is meant for SDK / `Bearer` dereference; the `hint` keeps a forgotten header from being misread as a CORS failure.

## JWT Security

### Validation layers (per request)

The gateway dispatches on the token's `iss` claim, and the two paths verify differently.

**A token from the trusted issuer** (every human):

1. **Signature** — verified against the issuer's published JWKS.
2. **Issuer and audience** — must match the configured issuer and this knowledge base's derived resource identity.
3. **Expiration** — enforced by the verifier.
4. **Subject and email** — the claim `subjectClaim` names must be present and non-empty, an `email` is required, and an `email_verified` of false is refused.
5. **Principal** — built from those claims. The DID is `did:web:<site domain>:users:<subject>`, the subject being the value of the configured claim — the email is carried for display and is not part of the identity; `name` and `picture` are carried through when the issuer sends them. Nothing is looked up, and there is no second admission check.

**What the record keeps about a person, and what it does not.** The DID is the identity, and it is all any artifact carries. The `name` is recorded separately — one line on the knowledge base's system log per name a subject has had, written by the gateway when that person acts and only when the name differs from the last one recorded — so that a reader can resolve a DID to a person from the log alone, without asking the issuer. **The email is never recorded**: it is carried on the token for display during a request and is written nowhere, which is deliberate, because an append-only log is the wrong home for a piece of personal data the display does not need. Nothing about a person is written for merely reading.

**A token the gateway itself signed** (software agents only):

1. **Signature** — HMAC-SHA256 against the `JWT_SECRET` key ring.
2. **Payload structure** — the claims must have the agent shape (`agent_claims` in `images/gateway/src/tokens.rs`); a token whose claims do not parse is rejected, not coerced.
3. **Expiration** — enforced at verification.

The claims are trusted on this path precisely because the gateway signed them: it is both the minter and the verifier, so a valid signature means this process asserted these facts itself.

### Gateway-signed token payload

Agents and media only — a person's token is the issuer's, and its claims are whatever that realm mints.

```json
{
  "did": "did:web:example.com:agents:anthropic:claude-opus-5",
  "email": "anthropic-claude-opus-5@agents.example.com",
  "name": "anthropic claude-opus-5",
  "domain": "example.com",
  "iat": 1698765432,
  "exp": 1698769032
}
```

`did` is the identity everything downstream keys on — the bus stamps it on every event, resource creation attributes to it, the signal ledger claims under it. There is no `isAdmin` claim and no `provider` claim; the shape is enforced at verification (`agent_claims` in `images/gateway/src/tokens.rs`).

## Implementation Details

### Bearer validation (`images/gateway/src/http.rs`)

A protected route takes the `Authenticated` extractor, which runs before its body is read: it takes the token from an `Authorization: Bearer` header — a missing one returns the actionable 401 above — and resolves the principal (`principal_from_token` in `images/gateway/src/principal.rs`). `GET /api/resources/{id}` takes `MediaOrBearer` instead, which accepts that resource's media token in `?token=` before falling back to the header.

### Route protection (`images/gateway/src/routes/mod.rs`)

Every route is one row of the route table, and its handler names the credential it needs: `Authenticated`, `MediaOrBearer`, or — for `POST /api/tokens/agent` — the issuer token carrying `semiont-service` it checks itself. A request on `/bus/*`, `/resources/*`, `/api/resources/*` or `/api/status` that matches no declared operation is authenticated before it is answered 404.

## The gateway's own credentials

The gateway reads two credentials from its environment:

| Variable | What it is |
|---|---|
| `JWT_SECRET` | The key ring that signs agent and media tokens, and nothing else |
| `SEMIONT_OIDC_CLIENT_ID`, `SEMIONT_OIDC_CLIENT_SECRET` | The gateway's own service account at the issuer, which it uses to reach the archivist |

It holds no credential on a person's behalf: it never signs anyone in, and verifies people's tokens against the issuer's published keys. The issuer a deployment trusts is named in the knowledge base's `knowledge-base.yaml`, at `spec.issuer`.

Nothing generates the signing key at request time, and the gateway refuses to start without one. Who supplies it depends on where the stack runs:

| Where the stack runs | Supplied by | Where it is kept |
|---|---|---|
| Your machine | `semiont start` | `jwt-secret` in the knowledge base's secrets store: its 1Password item, or a file in its state directory (not secure; for development only) |
| A codespace | The launcher inside the codespace | The file store, on the codespace's filesystem |
| Your own platform | You | Your platform's secret store, mapped to the variable |

The launcher says which key it used (`Token-signing key: generated and kept`, `reused`, or `from JWT_SECRET in the environment`) and never prints it. If tokens start failing, that line tells you whether the key changed. See [Secrets](../services/SECRETS.md).

### Rotating `JWT_SECRET` without cutting off the sidecars

`JWT_SECRET` is an **ordered, comma-separated list**: the first key signs, *every* key verifies. A single value is the one-key case and behaves exactly as before.

Replacing the key outright is what causes an outage: every agent and media token stops verifying at once. Sidecars recover on their own: a request, an emit or a stream refused 401 renews the sidecar's agent token at `/api/tokens/agent` once and is sent again with the new one ([TRANSPORT-CONTRACT.md § A refused credential](../../protocol/TRANSPORT-CONTRACT.md#a-refused-credential)). Rotating through the list avoids even that refusal. People are unaffected either way; their tokens are the issuer's and verify against its keys.

```bash
# 1. Mint a new key and put it FIRST, keeping the old one behind it.
export JWT_SECRET="$(openssl rand -hex 32),$OLD_SECRET"
semiont start --service gateway        # or restart however you deploy

# 2. Nothing breaks. New tokens are signed with the new key; tokens already
#    issued still verify against the old one, and each re-mints under the new
#    key when its holder next authenticates.

# 3. Once every outstanding agent token has had a chance to be re-minted
#    (an hour, the agent TTL above), drop the tail:
export JWT_SECRET="$NEW_SECRET"
semiont start --service gateway
```

**The ring signs agent and media tokens only.** People's tokens come from the issuer and verify against its published keys, so a `JWT_SECRET` rotation does not touch them. Retiring the old key early cuts off any sidecar still holding a token minted under it; wait out the agent TTL, or accept that the stragglers re-authenticate, which they do on a 401 without operator involvement.

Details worth knowing:

- **Each key must be at least 32 characters.** The check is per key, not on the whole string — `<valid>,short` would otherwise pass trivially. `semiont start` refuses such a value up front rather than letting the gateway crash-loop.
- **A comma cannot appear in a key**, so the delimiter is unambiguous: generated keys are hex, and the documented recipe is `openssl rand -hex 32`.
- **Media tokens** (`?token=`) sign and verify through the same ring, so they rotate with everything else. Their 5-minute TTL makes the grace window academic, but they are not on a separate path.
- **Two keys is the normal maximum.** The ring exists for a rotation window, not as a key store; trial verification costs one extra HMAC per key on the failing path.

## Admitting a worker someone else runs

A knowledge base admits a worker the way it admits a person: by an account its operator makes. A person's account holds a password or a passkey; a worker's holds the public half of the key that its owner's machine keeps. Nothing secret passes between the two people, either way.

**The worker's owner** prints the public half on the machine that runs the worker, and sends it:

```bash
semiont worker key > alice.jwks
```

It is a JWK Set: the key, and the key id each of the worker's sign-ins names (the key's RFC 7638 thumbprint). `semiont worker key --pem` prints the key as a PEM instead, with the key id on stderr. The private half never leaves that machine.

### At a knowledge base the launcher runs

```bash
semiont identity grant alice --key alice.jwks
```

This creates one client in the realm, `semiont-worker-alice`. It is the client the launcher makes for its own machine's worker, `semiont-worker-local`, with another key:

- confidential, authenticating by signed JWT with that key;
- its client-credentials grant enabled;
- its token stamped with the flat `roles` `semiont-service` and `semiont-worker`, and with this knowledge base's audience.

It prints the client id and the gateway's address, to send back. Before anything reaches the realm, it refuses a private key, a key that is not RSA, and the label `local`. If the knowledge base's documents state the gateway at a loopback address, it warns, since a worker on another machine cannot reach one.

Granting the same key again changes nothing. A new key under the same label replaces the old one on the same client, so the worker keeps its account, and the subject the knowledge base knows it by.

```bash
semiont identity revoke alice
```

This deletes that client, and no other. The worker's next sign-in is refused. Tokens it already holds stay good until they expire: its issuer token within the realm's access-token lifetime, and an agent token the gateway minted it within that token's own ([Token lifecycle](#token-lifecycle), [Revocation](#revocation)).

Both need the realm's bootstrap admin password, as `semiont identity sync` does.

### At an issuer you run

Create the client yourself. It is the same client:

- **Confidential**, authenticating by a **signed JWT**: RFC 7523's client assertion, RS256. Keycloak calls this authenticator "Signed JWT".
- **The worker's public key registered on it**, under the key id each assertion names: the `kid` of the JWK Set that `semiont worker key` prints. An issuer given the PEM must be given that key id too; Keycloak refuses an assertion naming a key id its client does not hold.
- **The client-credentials grant enabled**, and nothing else: no browser flow, no password grant.
- **A flat `roles` claim** carrying `semiont-service` and `semiont-worker`, and an **`aud`** carrying this knowledge base's resource identifier ([At the issuer](#at-the-issuer)).

The worker's assertion names the client as its `iss` and its `sub`, and the issuer's token endpoint as its `aud`, so the issuer must accept that audience. Its whole shape is [`specs/src/session/client-assertion-cases.json`](../../../specs/src/session/client-assertion-cases.json).

To revoke, delete the client.

### What the worker's owner does with it

The client id goes into the worker's environment as `SEMIONT_OIDC_CLIENT_ID`, beside its key as `SEMIONT_OIDC_CLIENT_KEY`. The gateway's address goes into its document, with the issuer the gateway names at `/.well-known/oauth-protected-resource` ([the worker's configuration](../../../images/worker/README.md#configuration)). The launcher configures its worker for the knowledge base it starts; a worker serving a knowledge base elsewhere is given its document by hand.

The record names a worker's work by the engine it ran, `agents:<provider>:<model>`, so two people's workers running one model are one agent there.

## Security Best Practices

### Token handling

1. **A client holds its own tokens, and never as a cookie.** The SDK attaches the access token to each request explicitly, and keeps the access and refresh pair wherever its storage adapter puts it. The Browser's is `localStorage`, one entry per knowledge base, so a session survives a reload and a script running in the Browser's origin can read it. `semiont login` keeps them in the launcher's sign-in store, a file only its owner can read. A script chooses its own. The gateway holds no credential on a person's behalf.
2. **The access token lifetime is the containment window.** A leaked access token works until it expires, and disabling the account at the issuer prevents a replacement rather than cancelling the one in hand. Keep the realm's lifetime short for that reason. A leaked refresh token obtains new access tokens until the person signs out, which revokes it, or the account is disabled.
3. **Always use HTTPS in production.**
4. **Open CORS is intentional and safe here** because no credentials are carried (see [Security](./SECURITY.md)). Never re-introduce credentialed CORS or origin-reflection.

### At the issuer

These decisions sit in the realm: who may register, which domains are admitted, how long an access token lives, and whether an account is enabled. Semiont enforces none of them and cannot compensate for them.

Two of those the launcher does write into the realm it imports, rather than inherit, so they are decisions someone can read back rather than Keycloak defaults that move with an upgrade — the access token lifetime in the table above, and the **user profile**. The profile requires `firstName` and `lastName`, so a person an administrator created an account for is asked for their own name at first sign-in. Keycloak composes the `name` claim from those two, and that claim is what every annotation and resource they author is attributed to; `semiont useradd` deliberately sets no display name, because splitting one typed string on a space gets "Mary Jane" and "van der Berg" wrong.

An operator federating a **different** issuer owes Semiont the following. Everything else above is this realm's shape, not a requirement of the gateway.

**Every token the gateway accepts:**

- **`iss` exactly equal to the configured issuer URL.** Discovery is read at `<issuer>/.well-known/openid-configuration`, and a document naming a different `issuer` is refused rather than followed.
- **RS256, verifiable against the `jwks_uri` that document publishes.** Keys are selected by `kid`; no other algorithm is accepted.
- **`aud` carrying this knowledge base's resource identifier** — the exact string `/.well-known/oauth-protected-resource` publishes as `resource`. It is derived from the committed `did:web` domain, not configured, so it cannot be set to something else at the issuer's convenience: the issuer must be told to stamp it. This is the requirement operators miss, and missing it fails every request with a 401 that looks like a key problem.

**A person's token also needs** the claims [Validation layers](#validation-layers-per-request) lists — a `sub`, an `email`, and an `email_verified` that is not `false`. `name` is optional, and is what every annotation and resource they author is attributed to.

**A service account's token also needs** a flat `roles` array containing `semiont-service` — an array of strings at the top level, deliberately not Keycloak's nested `realm_access.roles`. An issuer with its own group model maps it into that claim.

**A worker's token also needs `semiont-worker`** in that same array. The gateway stamps it onto the agent token a worker mints, and the dispatcher admits a `job:claim` only from a token carrying it — `semiont-service` is what every sidecar has, so it cannot be what distinguishes a worker. A worker that is not yours is admitted by its key: see [Admitting a worker someone else runs](#admitting-a-worker-someone-else-runs).

**For people to sign in at all**, the issuer needs a public client that supports the device grant (for `semiont login`) and an authorization endpoint that enforces PKCE with redirect URIs covering the Browser.

**Each Semiont service needs its own client**, not one shared between them: the archivist, dispatcher, gateway, librarian, smelter, weaver and worker each authenticate as themselves, and a shared credential would let any one of them mint any other's identity. For the Keycloak the launcher runs, named by `spec.issuer.ref`, the launcher creates all seven. For an issuer at `spec.issuer.external` you create them there and supply each secret as `SEMIONT_OIDC_CLIENT_SECRET_<SERVICE>` — but the worker's: the worker proves itself with a key, signing each sign-in (a JWT client assertion, RFC 7523), so its client, `semiont-worker-local`, authenticates by signed JWT and holds the public key `semiont worker key` prints. See [Maintenance](./MAINTENANCE.md) for rotation.

`semiont start` preflights every one of these against whatever issuer is configured and reports what it finds, so a federation that does not conform says so at startup rather than one 401 at a time. For a realm the launcher runs, `semiont identity sync` repairs what the preflight finds: it creates missing service-account clients, reconciles an existing client's roles mapper (a realm imported before the worker role existed) and the worker's client's key (this machine's), adds the loopback redirect URIs, turns the implicit flow off, and sets the access-token lifetime to match the Issuer document. It reconciles configuration only and never touches accounts.

### API

- Every route requires a bearer token unless the spec declares it public (`security: []`).
- What one principal may take (the streams it holds, the emits it makes) is limited alike for people and agents, by a baseline and a coefficient per role: see [Limits](../../protocol/TRANSPORT-HTTP.md#limits). A request whose token is refused is limited per holder the token names, and those that name none together: see the same table. Limits per address are an ingress's to apply.
- Every JSON body is validated against its schema in `specs/`.

## Troubleshooting

**"Unauthorized" (401)**
- Confirm the `Authorization: Bearer <token>` header is present and well-formed.
- A raw browser navigation to a protected resource is unauthenticated by design — use the SDK or a media `?token=`.
- The token may be expired — obtain a new one from the issuer.
- The token may be for another audience. This deployment accepts only tokens whose audience is its own derived resource identity, published at `/.well-known/oauth-protected-resource`.
- The token's email may not be marked verified by the issuer, which is refused.
- The token may lack the claim `subjectClaim` names; the gateway refuses it, naming the claim.

**A granted worker's sign-in is refused (`invalid_client`)**
- It signs with another key than the one registered: its owner may have made a new one. `semiont worker key` on its machine prints the key it signs with; grant that one under the same label.
- Its client was revoked.
- At an issuer you run: the key id registered is not the key's thumbprint, or the issuer does not accept its token endpoint as an assertion's `aud`.

**Sign-in fails at the issuer**
- The account may be disabled there. That is where enable and disable live; `semiont useradd --active` re-enables one.
- Nothing about this is visible in the gateway's logs, because the gateway is never contacted for a sign-in that fails.

## Related Documentation

- [Security](./SECURITY.md): what Semiont enforces, and what it does not
- [Secrets](../services/SECRETS.md): where the signing key and the service accounts' secrets are kept
- [Deploying Semiont](./DEPLOYMENT.md): bringing an issuer of your own
- [Database](./DATABASE.md): the PostgreSQL Keycloak uses
- [Configuration](./CONFIGURATION.md#the-issuer): `spec.issuer`, and the Issuer document
