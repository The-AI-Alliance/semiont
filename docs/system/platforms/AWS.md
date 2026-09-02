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

Five published service images (GitHub Container Registry, tagged per release plus `latest`):

| Image | Role | Port |
|---|---|---|
| `ghcr.io/the-ai-alliance/semiont-gateway` | API, auth, event log, projections | 4000 |
| `ghcr.io/the-ai-alliance/semiont-browser` | Browser UI | 3000 |
| `ghcr.io/the-ai-alliance/semiont-worker` | Job / generation worker | 9090 |
| `ghcr.io/the-ai-alliance/semiont-smelter` | Embedding / vector pipeline | 9091 |
| `ghcr.io/the-ai-alliance/semiont-weaver` | Graph projection | 9092 |

Plus the infrastructure containers a stack needs: `postgres`, `neo4j`, `qdrant`, and — for local
inference — `ollama`.

## How stacks are actually run today

- **The `semiont` launcher** (host-installed via
  `brew install the-ai-alliance/semiont/semiont`) — `semiont start` from a KB directory. This is the
  supported path, local or GitHub Codespaces. See [apps/launcher](../../../apps/launcher/README.md).
- **`docker compose`** against a KB's own `.semiont/compose/backend.yml`, which pulls the same
  published images — equivalent end state to `semiont start`.

See [CONTAINER-TOPOLOGY.md](../CONTAINER-TOPOLOGY.md) for how the containers relate.

## If you want to run it on ECS Fargate anyway

The images are self-contained; the work is entirely in the surrounding platform wiring. Expect to
solve these yourself:

- **Config delivery.** Every service reads `~/.semiontconfig` (TOML) for service endpoints, the
  graph / vector / inference driver settings, and the database connection. You must get that file
  into each task — a bind mount locally; a volume, init container, or baked layer on ECS.
- **Secrets.** `JWT_SECRET`, `SEMIONT_WORKER_SECRET`, and any inference API keys arrive as
  environment variables. Semiont does not read Secrets Manager or SSM — that mapping is yours.
- **Service discovery.** Services address each other by URL from the config
  (`services.gateway.publicURL`, and so on), not by any AWS-specific mechanism.
- **Persistence.** PostgreSQL, Neo4j, and Qdrant need durable volumes. The KB's `.semiont/events/`
  directory is the system of record and must survive task replacement.
- **The KB working tree.** The gateway bind-mounts the KB repo at `/kb`. On a cluster you need a
  shared filesystem or a different content strategy.

None of the above is tested or supported. Treat a cloud deployment as your own integration.

## Related Documentation

- [CONTAINER-TOPOLOGY.md](../CONTAINER-TOPOLOGY.md) — what runs where, and which layer runs it
- [administration/IMAGES.md](../administration/IMAGES.md) — how the images are built and published
- [administration/DEPLOYMENT.md](../administration/DEPLOYMENT.md) — deployment overview
- [administration/CONFIGURATION.md](../administration/CONFIGURATION.md) — the config schema
- [services/SECRETS.md](../services/SECRETS.md) — how secrets reach services
