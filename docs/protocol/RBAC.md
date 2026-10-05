# Roles

What a caller's role decides in Semiont, which is very little. For how callers are authenticated, and how tokens are issued, verified and revoked, see the operator's [Authentication](../operator/administration/AUTHENTICATION.md).

## One decision: authenticated, or not

The gateway makes one authorization decision for every request: the caller's token verifies, or the answer is **401**. No gateway route returns 403, because no gateway route consults a role to decide whether a person may do something.

- **Every authenticated person can read and write everything** in the knowledge base. There is no permission per resource, per annotation or per person.
- **There are no human roles.** The principal the gateway builds from a person's token carries no role, flag or group that any route reads.
- **Admission is the issuer's.** Who may sign in is decided where tokens are minted. The gateway admits every subject whose token verifies, and keeps no list of its own.

Four operations are public: `GET /`, `GET /api/health`, `GET /api/openapi.json` and `GET /.well-known/oauth-protected-resource`. The spec is the authority: an operation declaring `security: []` is public, and the [gateway conformance suite](../../tests/conformance/gateway/README.md) fails if any other answers an unauthenticated caller with anything but 401.

## Two roles, both for services

A role is a string in a flat `roles` array at the top level of a token. It is deliberately not Keycloak's nested `realm_access.roles`: nothing in verification carries a vendor's name, so an issuer of any kind maps its own groups into this claim.

| Role | Marks | What it permits |
|---|---|---|
| `semiont-service` | A service account: one of Semiont's own processes, not a person | Exchanging its issuer token for an agent token at `POST /api/tokens/agent`, and reading through the archivist |
| `semiont-worker` | A principal that may run jobs | Claiming a job: the dispatcher admits a `job:claim` only from a token that carries it |

Every one of Semiont's services carries `semiont-service`, so it proves a caller is a service and nothing finer. `semiont-worker` is a separate grant, made only to workers.

**A worker is authorized by the role, not by which client it is.** That is what lets a worker that is not the deployment's own take part: the operator grants its client the role at the issuer, and nothing else changes.

**The gateway stamps roles; a client never sets them.** On every emit the gateway clears whatever `_roles` the payload carried and writes the verified token's. A service that reads `_roles` reads what the gateway verified. See [identity on the bus](EVENT-BUS.md#identity-_userid-and-_roles-are-gateway-stamped).

**A role is an authorization fact, never provenance.** It is read when a request is admitted and is not recorded. What the record keeps about who did something is their DID.

## What a role changes about limits

Every principal is limited in how many streams it holds and how fast it emits. A role changes the coefficient, not the rule: the two service roles are unlimited where a person has a baseline. The numbers are declared in the spec, on the operations they apply to: see [Limits](TRANSPORT-HTTP.md#limits).

## What a worker's role obliges

A principal with the worker role acts on someone else's behalf, so its writes must say whose:

- A worker's `mark:commit` or resource creation must cite the job it is for.
- The job must be one that worker holds.
- The knowledge base then attributes the result to whoever asked for the job, with the worker's model as the generator.

A write from a worker that cites no job, or a job it does not hold, is refused.

## Where it is implemented

- The role names and how a claim is read: [packages/core/src/service-role.ts](../../packages/core/src/service-role.ts) and the Rust SDK's [roles.rs](../../packages/sdk-rust/src/roles.rs), held to one literal by `npm run lint:service-role`
- The gateway's principal: [apps/gateway/src/principal.rs](../../apps/gateway/src/principal.rs)
- The archivist's read path: [packages/make-meaning/src/archivist/archivist-read-path.ts](../../packages/make-meaning/src/archivist/archivist-read-path.ts)
- The dispatcher's claim check: [apps/dispatcher/handlers/src/handlers.rs](../../apps/dispatcher/handlers/src/handlers.rs)
