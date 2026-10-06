# Gateway Authentication

How the gateway authenticates a request, and where each part of it lives. For
the whole bearer-only model — the issuer, sign-in, rotation — read the
[System Authentication Architecture](../../../docs/operator/administration/AUTHENTICATION.md)
first; the `bearerAuth` and `mediaToken` schemes in
[specs/src/openapi.json](../../../specs/src/openapi.json) are the contract.

## The model

- **Bearer only.** `Authorization: Bearer <JWT>` on every protected request —
  the scheme matched in any case; another scheme, no header, or a cookie is no
  credential. `GET /api/resources/{id}` also takes that resource's media token
  in `?token=`, for the links that cannot send a header.
- **Two kinds of token, told apart by `iss`.** A token from the trusted issuer
  (`identity.issuer`) is a person or a service account, verified RS256 against
  the keys the issuer publishes. Any other is one the gateway signed itself — an
  agent token — verified HS256 against its key ring, `JWT_SECRET`.
- **No admission of its own.** A token the issuer signed, for this knowledge
  base, within its times, is admitted. Nothing reads a role to decide access and
  no route answers 403; a refusal is always a 401.
- **The spec decides what is public.** Four operations are: `GET /api/health`,
  `GET /`, `GET /api/openapi.json`, `GET /.well-known/oauth-protected-resource`.
  The [conformance suite](../../../tests/conformance/gateway/README.md) probes
  every declared operation without a credential and with a bad one.

## Where it lives

| Part | File |
|---|---|
| The `Authenticated` and `MediaOrBearer` extractors, the challenge, the 401 bodies | [src/http.rs](../src/http.rs) |
| Which token it is, and the principal it names | [src/principal.rs](../src/principal.rs) |
| The issuer's keys: discovery, the key set, when it is fetched | [issuer.rs](../../../packages/http-service-rust/src/issuer.rs), in the crate the Rust services that serve HTTP share |
| The key ring, agent and media tokens | [src/tokens.rs](../src/tokens.rs) |
| How a person and an agent are named | the `semiont` crate's [identity.rs](../../../packages/sdk-rust/src/identity.rs), held to [specs/src/principals/cases.json](../../../specs/src/principals/cases.json) |
| The role names | the `semiont` crate's [roles.rs](../../../packages/sdk-rust/src/roles.rs), held to the launcher's and core's by `npm run lint:service-role` |

A protected handler takes `Authenticated` (or `MediaOrBearer`), which runs
before its body is read, so an unauthenticated request never reaches a parser.
`POST /api/tokens/agent` checks its own caller: an issuer token carrying
`semiont-service`.

## What a request goes through

1. **The token** — from the `Authorization` header; none is a 401 with a
   `WWW-Authenticate: Bearer resource_metadata="…"` challenge and a `hint`
   naming the header.
2. **Its issuer** — read, unverified, to choose the verifier.
3. **Its signature and times** — an issuer token against the key its `kid`
   names in the issuer's set (see *The issuer's keys*, below), with
   `iss` equal to the issuer, `aud` carrying this knowledge base's resource
   identifier, and `exp` and `nbf` held with no leeway. An agent token against
   each key of the ring in turn; expired or not yet valid ends the walk.
4. **The principal** — built from the claims, with no lookup: a person is
   `did:web:<domain>:users:<the claim identity.subjectClaim names>`, and needs
   `email`, with `email_verified` not `false`; an agent is the DID its token
   carries. Either is a `UserId`
   ([specs/src/identifiers/kinds.json](../../../specs/src/identifiers/kinds.json)):
   a token whose claims do not make one names no principal.

Any failure is `401 {"error":"Invalid token"}` with the `invalid_token`
challenge; the reason goes to the log (`auth_failed`), never to the caller.

## The issuer's keys

The gateway holds the key set the issuer publishes, and fetches it on three
occasions. Their timings are the `bearerAuth` scheme's `x-semiont-limits` in
[specs/src/openapi.json](../../../specs/src/openapi.json):

- **None is held**, or the one held is `keySetMaxAgeSeconds` old.
- **A token names a `kid` the set lacks**, and the set is
  `keyRefetchCooldownSeconds` old. A newer set that still lacks it refuses the
  token until it has aged as long.

One fetch runs at a time, discovery included, and has
`keyFetchDeadlineSeconds`. A request that needs the keys while one is in flight
waits for it and takes its outcome. A fetch that fails, or runs out of time, is
not tried again for `keyRefetchCooldownSeconds`: the tokens that needed it are
refused 401 with its error in the log, and a token whose key the gateway still
holds is verified as before. So an issuer that is down, slow or silent costs a
request at most one deadline, and is asked once per cooldown however many
tokens arrive.

A token reaches this path by its `iss` claim, read before anything is
verified, so any caller can cause the fetch that is due. None can cause more
than the one.

## What a refused request costs

A request answered 401 is read as far as its `Authorization` header and no
further: no body, no call to the Archivist, nothing published. It is logged
([LOGGING.md](LOGGING.md#authentication-failures-warn)) and counted in
`semiont.gateway.unauthenticated` by its `reason`. An issuer token costs a
signature check against the keys held; a token the gateway signed, one HMAC
per key of the ring.

Nothing bounds how many such requests one caller sends. Every limit the
gateway keeps is on a verified principal, a client or a stream, so it applies
only once a request has authenticated; before that there is the connection cap
(GatewayConfig `capacity.connections`). Protection per caller before a token is
read is an ingress's.

## The tokens the gateway mints

**Agent tokens** — `POST /api/tokens/agent`. A service account presents its
issuer token and names a (provider, model); the gateway answers a token for
that agent, signed with the first key of `JWT_SECRET`, for an hour:

```json
{
  "did": "did:web:example.github.io:my-kb:agents:anthropic:claude-sonnet-5",
  "email": "anthropic-claude-sonnet-5@agents.example.github.io",
  "name": "anthropic claude-sonnet-5",
  "domain": "example.github.io:my-kb",
  "roles": ["semiont-worker"],
  "iat": 1698765432,
  "exp": 1698769032,
  "iss": "example.github.io:my-kb"
}
```

`roles` is there only when the service account carried `semiont-worker`. The
hour is the revocation window: an agent has no account anywhere to disable.

**Media tokens** — `POST /api/tokens/media` with `{ "resourceId": … }`: a
token naming that one resource (`purpose: "media"`, `sub`) for five minutes,
accepted only by `GET /api/resources/{id}` for that id.

**Signing out** needs nothing here: the gateway never issued the session. A
client forgets its session and revokes its refresh token at the issuer; the
access token in hand lapses minutes later.

## Debugging

- **Every 401 is logged** at `warn` with `type: "auth_failed"`, a `reason`
  (`missing_token`, `invalid_token`, `invalid_media_token`) and the verifier's
  error, and counted by that reason in `semiont.gateway.unauthenticated`;
  `logLevel: debug` also logs each success with the DID it resolved.
- **`JWT_SECRET` is a ring**: the first key signs, every key verifies, and each
  must be 32 characters or more — check them one by one:
  `echo "$JWT_SECRET" | tr ',' '\n' | awk '{ print NR": "length($0)" chars" }'`.
- **An issuer token refused**: `iss` must equal `identity.issuer` exactly
  (scheme, host, port, path); `aud` must carry the knowledge base's resource
  identifier (`/.well-known/oauth-protected-resource` publishes it as
  `resource`); the issuer's discovery document and key set must be reachable
  from the gateway.
- **Who does a token name?** `GET /api/users/me` with it answers the DID,
  address, name and domain the gateway resolved.
