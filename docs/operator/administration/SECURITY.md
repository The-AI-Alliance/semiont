# Security

What Semiont enforces, what it leaves to the issuer and to your platform, and what it does not do. To report a vulnerability, see [Reporting security issues](#reporting-security-issues).

## What Semiont enforces

**Every request is authenticated.** Authentication is bearer-only: an `Authorization: Bearer` token on every request, and no session cookies. Semiont is a resource server, not an authorization server. It runs no sign-in flow and holds no password. People and services obtain tokens from the knowledge base's trusted issuer, and the gateway verifies each one against that issuer's published keys. Four operations are public: `GET /`, `GET /api/health`, `GET /api/openapi.json` and `GET /.well-known/oauth-protected-resource`. [Authentication](./AUTHENTICATION.md) has the whole model.

**There is one authorization decision: authenticated, or 401.** No gateway route returns 403, and none reads a human role. Every authenticated caller can read and write all content in the knowledge base. Two roles exist, and both mark services, not people: `semiont-service` admits a service account to `POST /api/tokens/agent` and to the archivist, and `semiont-worker` admits a worker's claim on a job. See [RBAC.md](../../protocol/RBAC.md).

**Every body is validated.** Each JSON body is checked against its schema in `specs/` and bounded by its operation's size limit.

**Every principal is limited.** The streams one principal holds and the emits it makes are bounded, for people and agents alike, and so are the bytes and connections one gateway process holds. A refusal is a 429 or a 503 with `Retry-After`: see [Limits](../../protocol/TRANSPORT-HTTP.md#limits).

**Errors carry no internals.** No error body carries a stack trace, a source path or a secret's name. The cause goes to the log.

**CORS is open and carries no credentials.** Because authentication is a header a client attaches on purpose, and never an ambient cookie, the gateway answers any origin. Do not put a cookie-based or credentialed layer in front of it.

**The gateway has no development mode.** It reads no setting that relaxes any of the above, and behaves the same wherever it runs.

The [gateway conformance suite](../../../tests/conformance/gateway/README.md) holds a built gateway to this on every pull request: every protected operation answers 401 without a credential and to a token it cannot verify, public operations answer without challenging, undeclared paths answer 404, and every response carries the security headers. A gateway whose routes are not exactly the spec's operations refuses to start.

## What is the issuer's

Who may sign in is decided at the issuer, and nowhere else. The gateway admits every subject whose token verifies.

- **Admission**: who may register, and from which domains.
- **Multi-factor authentication**, and federation with another provider.
- **Token lifetime**, which is also the revocation window. Disabling an account stops new tokens at once; a token already issued works until it expires.
- **The accounts themselves.** Semiont keeps no user table.

## What is your platform's

- **TLS.** The gateway serves HTTP and sends `Strict-Transport-Security`, which a browser honours only over HTTPS. Terminate TLS in front of it.
- **Network placement.** Only the gateway and the Browser need to be reachable by clients. Everything else can sit on a private network.
- **Limits per address**, and allow or block lists. The gateway limits per principal, after a token is read.
- **Secrets.** Where they are stored and how they reach each container: see [Secrets](../services/SECRETS.md).
- **File permissions** on the knowledge base's working tree and the stores beside it.
- **Backups** of the working tree and of the issuer's database: see [Backup](./BACKUP.md).

## Where data is, and what is recorded

- **Content and the event log are plain files** in the knowledge base's working tree. Semiont does not encrypt them; encryption at rest is the storage's.
- **Every event carries the DID of whoever caused it**, so the event log is the audit trail.
- **A person's name is recorded** once per name they have had, so a reader can resolve a DID to a person from the log alone. **Their email is never recorded.**
- **The graph, the vectors and the views** are derived from those files and hold nothing that is not in them.

## Secrets

The secrets a stack has, who generates each and which service receives it are in [Secrets](../services/SECRETS.md). Rotating them is in [Maintenance](./MAINTENANCE.md#secret-rotation) and, for the signing key, in [Authentication](./AUTHENTICATION.md#rotating-jwt_secret-without-cutting-off-the-sidecars).

## Supply chain

Every published image is scanned for `HIGH` and `CRITICAL` vulnerabilities before it is pushed, and a finding with a fix fails the publish. Each image carries a signed build provenance and a bill of materials, and the service images also pass a licence policy. The gateway's and the dispatcher's binaries record the crates they link, which is what the scan reads, and those crates are checked against the RustSec advisory database daily.

Verify an image before running it where it matters: [Supply-chain verification](./IMAGES.md#supply-chain-verification).

## What to watch

- **401 responses.** It is the only refusal the gateway issues for identity. A 403 in your logs came from something in front of it.
- **429 and 503 responses**, which mean a principal or the process reached a limit.
- **Sign-in failures**, which are in the issuer's logs. The gateway is never contacted for a sign-in that fails.

Structured logs carry `trace_id` and `span_id`, so a failing request's log line leads to its trace: see [Observability](./OBSERVABILITY.md).

## What Semiont does not do

- **Access control within a knowledge base.** There is no per-resource, per-annotation or per-user permission. Whoever can sign in can read and write everything in it. Separate what must be kept separate into different knowledge bases, and control at the issuer who is issued a token for each.
- **Encryption at rest.**
- **Limits per address, or address allow and block lists.** These belong to an ingress.
- **Revoking someone else's session at once.** Disable the account at the issuer, and the access token they hold expires within its lifetime.
- **A query interface over the audit trail.** The trail is the event log; reading it is reading the files.

## Reporting security issues

Do not open a public issue. Report privately through GitHub Security Advisories at <https://github.com/The-AI-Alliance/semiont/security/advisories/new>, with a description, steps to reproduce, the affected versions and the impact. The repository's [SECURITY.md](../../../SECURITY.md) is the policy.

## Your responsibilities

Semiont is open-source software, provided as is. Whoever deploys it is responsible for the controls their use needs, for compliance with the regulations that apply to them, and for assessing and maintaining their own deployment.
