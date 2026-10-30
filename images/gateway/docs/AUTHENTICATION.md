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
- **One kind of bearer: the issuer's.** A token from the trusted issuer
  (`identity.issuer`), a person's or an agent's, verified RS256 against the keys
  the issuer publishes. Any other is refused: the one token the gateway signs
  itself is a media token, which is no bearer.
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
| The issuer's keys: discovery, the key set, when it is fetched | [issuer.rs](../../../packages/rust/http-service/src/issuer.rs), in the crate the Rust services that serve HTTP share |
| The key ring and media tokens | [src/tokens.rs](../src/tokens.rs) |
| How a person and an agent are named | the `semiont` crate's [identity.rs](../../../packages/rust/sdk/src/identity.rs), held to [specs/src/principals/cases.json](../../../specs/src/principals/cases.json) |
| The role names, and the claim that marks an agent's account | the `semiont` crate's [roles.rs](../../../packages/rust/sdk/src/roles.rs), held to the launcher's by `npm run lint:service-role` |

A protected handler takes `Authenticated` (or `MediaOrBearer`), which runs
before its body is read, so an unauthenticated request never reaches a parser.

## What a request goes through

1. **The token** — from the `Authorization` header; none is a 401 with a
   `WWW-Authenticate: Bearer resource_metadata="…"` challenge and a `hint`
   naming the header.
2. **Its signature and times** — against the key its `kid` names in the
   issuer's set (see *The issuer's keys*, below), with `iss` equal to the
   issuer, `aud` carrying this knowledge base's resource identifier, and `exp`
   and `nbf` held with no leeway.
3. **The principal** — built from the claims, with no lookup, by the subject
   the claim `identity.subjectClaim` names: an agent,
   `did:web:<domain>:agents:<subject>`, when the token's `kind` claim is
   `agent`, which the issuer stamps on every agent's account, and a person,
   `did:web:<domain>:users:<subject>`, otherwise. An `email` is optional; when
   present, `email_verified` must not be `false`. Either DID is a `UserId`
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
`semiont.gateway.unauthenticated` by its `reason`. A token costs a signature
check against the keys held.

A refused request is counted against the holder its token names, read without
verifying it: the claim the gateway names a holder by, `identity.subjectClaim`,
of a token naming the trusted issuer. A request with no token, or with one that
names another issuer or no holder, is counted in one count shared by all such
requests. Each holder may have
`refusalBurst` requests refused at once and `refusalsPerSecond` after, per
process (the bearer scheme's `x-semiont-limits`); past that, a refused request
is answered 429 `refusal-rate` with a `Retry-After`, in place of its 401, and
counted in `semiont.gateway.refused`. A token that verifies is never counted or
limited, so a forged token naming someone else cannot lock them out. The
gateway counts at most `refusalHolders` holders and drops the one it began
counting first. A caller that varies the holder its tokens name is bounded by
the connection cap (GatewayConfig `capacity.connections`) alone; protection
per address is an ingress's.

## The token the gateway mints

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
