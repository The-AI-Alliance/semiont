# Running Semiont on AWS

> **Not directly supported.** The Semiont CLI has **no AWS platform**. The former CDK-based
> deployment — two CloudFormation stacks, ECR publishing, ECS task-definition rollouts, and the
> `semiont publish` / `semiont update` commands that drove them — has been **removed**. Nothing in
> this repository provisions AWS infrastructure.
>
> What remains true: Semiont ships as **ordinary container images**, and any container platform can
> run them — **ECS Fargate**, EKS, Nomad, or a plain VM with Docker. Wiring that up is **an exercise
> for the reader**; there is no first-party tooling, IaC, or configuration for it.

## What Semiont actually ships

Seven published service images plus the infrastructure containers a stack needs (`postgres`,
`neo4j`, `qdrant`, `ollama`, and `nats` when a broker-backed driver is selected). The image
table lives in **one place** — [DEPLOYMENT.md § What gets deployed](../administration/DEPLOYMENT.md)
— and is not restated here: an earlier copy on this page drifted to five images and a stale
gateway role, which is exactly what a second copy does.

## How stacks are actually run today

- **The `semiont` launcher** (host-installed via
  `brew install the-ai-alliance/semiont/semiont`) — `semiont start` from a KB directory. This is the
  supported path, local or GitHub Codespaces. See [apps/launcher](../../../apps/launcher/README.md).
- **`docker compose`** against a KB's own `.semiont/compose/backend.yml`, which pulls the same
  published images — equivalent end state to `semiont start`.

See [CONTAINER-TOPOLOGY.md](../CONTAINER-TOPOLOGY.md) for how the containers relate.

## If you want to run it on ECS Fargate anyway

The images are self-contained; the work is entirely in the surrounding platform wiring. The
platform-neutral checklist — config delivery, secrets, service discovery, persistence, the KB
working tree, migrations, restart and liveness, and multiple gateway replicas — is
[DEPLOYMENT.md § Everything else — your own integration](../administration/DEPLOYMENT.md).
What is specifically AWS about it:

- **Secrets.** Semiont reads environment variables, not Secrets Manager or SSM — the
  task-definition `secrets` mapping from your store to `JWT_SECRET`, each service's
  `SEMIONT_OIDC_CLIENT_SECRET`, and inference API keys is yours to write.
- **Config delivery.** Every service reads `~/.semiontconfig` (TOML); on ECS that means a
  volume, an init container, or a baked layer per task.
- **The KB working tree.** The Archivist bind-mounts the KB repo at `/kb`; on Fargate that
  points at EFS — and the `.semiont/events/` directory inside it is the system of record, so
  that volume's durability is the stack's.
- **Restart and liveness.** Each image runs `tini` wrapping one process and exits when it
  dies — ECS task restart policy and health checks behave normally. Do not set
  `SEMIONT_SUPERVISE`; the in-container supervisor is the launcher's substitute for exactly
  the restart policy ECS already has.
- **Scaling out.** Gateway replicas behind an ALB require the broker-backed drivers and an
  SSE-tolerant load balancer configuration (no response buffering; idle timeout above the
  15-second heartbeat) — the requirements and the per-service replica table are in
  [DEPLOYMENT.md](../administration/DEPLOYMENT.md) and [SCALING.md](../administration/SCALING.md).

None of the above is tested or supported. Treat a cloud deployment as your own integration.

## Related Documentation

- [CONTAINER-TOPOLOGY.md](../CONTAINER-TOPOLOGY.md) — what runs where, and which layer runs it
- [administration/IMAGES.md](../administration/IMAGES.md) — how the images are built and published
- [administration/DEPLOYMENT.md](../administration/DEPLOYMENT.md) — deployment overview
- [administration/SCALING.md](../administration/SCALING.md) — what scales, per service
- [administration/CONFIGURATION.md](../administration/CONFIGURATION.md) — the config schema
- [services/SECRETS.md](../services/SECRETS.md) — how secrets reach services
