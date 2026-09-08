# Semiont Deployment Guide

How a Semiont stack is actually deployed today, and what is left to you if you want to run it on a
cloud container platform.

> **Nothing here deploys to a cloud.** The AWS platform, its CDK templates, and the old
> `publish` / `update` commands have all been **removed**, along with the CLI that carried them.
> There is no first-party image-publishing or rollout tooling for a cloud target. Semiont ships container
> images; running them somewhere is deployment, and beyond the two supported paths below it is **an
> exercise for the reader**.

**Related guides**: [Platforms](../platforms/README.md) | [Images](./IMAGES.md) |
[Configuration](./CONFIGURATION.md) | [Secrets](../services/SECRETS.md) |
[Container topology](../CONTAINER-TOPOLOGY.md) | [Maintenance](./MAINTENANCE.md) |
[Observability](./OBSERVABILITY.md) | [Troubleshooting](./TROUBLESHOOTING.md)

---

## What gets deployed

Seven published service images, plus the infrastructure containers a stack needs
(`postgres`, `neo4j`, `qdrant`, and `ollama` for local inference):

| Image | Role | Port |
|---|---|---|
| `ghcr.io/the-ai-alliance/semiont-gateway` | API, auth, event log, projections | 4000 |
| `ghcr.io/the-ai-alliance/semiont-browser` | Browser UI | 3000 |
| `ghcr.io/the-ai-alliance/semiont-worker` | Job / generation worker | 24100 |
| `ghcr.io/the-ai-alliance/semiont-smelter` | Embedding / vector pipeline | 24101 |
| `ghcr.io/the-ai-alliance/semiont-weaver` | Graph projection | 24102 |
| `ghcr.io/the-ai-alliance/semiont-archivist` | Git-backed record, projection writer | 24103 |
| `ghcr.io/the-ai-alliance/semiont-librarian` | Gatherer / view reader | 24104 |

Images are built and published by CI, not by the CLI — see [IMAGES.md](./IMAGES.md).

---

## Supported path 1 — the `semiont` launcher

The host-installed launcher is the supported way to run a stack, locally or in GitHub Codespaces:

```bash
brew install the-ai-alliance/semiont/semiont

cd /path/to/your-kb
semiont start                 # pulls the images and brings the stack up
semiont status                # container state + per-service health
semiont logs                  # follow service logs
semiont stop                  # tear down
```

`semiont start --runtime codespace` places the stack in a GitHub Codespace instead of locally. Full
reference: [apps/launcher](../../../apps/launcher/README.md).

**Restart is the launcher's job on this path, and only on this path.** A laptop has no scheduler:
`semiont start` brings the stack up and exits, so nothing outside a container would restart a
crashed or hung service. For local runs the launcher therefore enables an in-container supervisor,
which restarts a crashed process, kills one that stops answering its health endpoint, and gives up
rather than looping on a boot failure. Codespace stacks do not use it — compose owns the services
inside — and neither does any other path below.

---

## Supported path 2 — `docker compose`

Each KB repo ships its own compose file that pulls the same published images:

```bash
cd /path/to/your-kb
docker compose -f .semiont/compose/backend.yml up
docker compose -f .semiont/compose/backend.yml pull    # refresh a cached :latest
```

Equivalent end state to `semiont start`. Pin a version with `SEMIONT_VERSION`; select an inference
config with `SEMIONT_CONFIG`. See the header comments in that compose file for the current options.

Restart is compose's job here — the images run one process and exit when it dies, so a `restart:`
policy behaves normally. Note that compose restarts on **exit**, not on **unhealthy**: a process
that hangs while still holding its port will not be replaced. If that matters, use a scheduler with
liveness probes, or run an autoheal sidecar.

---

## Everything else — your own integration

Any container platform can schedule these images: ECS Fargate, EKS/Kubernetes, Nomad, or a VM with
Docker. Nothing in this repository does it for you, and none of it is tested. What you will need to
solve:

- **Config delivery.** Every service reads `~/.semiontconfig` (TOML) for service endpoints, driver
  settings (graph, vectors, inference), and the database connection. Getting that file into each
  container is yours to arrange. Schema: [CONFIGURATION.md](./CONFIGURATION.md).
- **Secrets.** `JWT_SECRET`, `SEMIONT_WORKER_SECRET`, and inference API keys arrive as environment
  variables. Semiont reads no cloud secret store directly. See [SECRETS.md](../services/SECRETS.md).
- **Service discovery.** Services address each other by URL from the config
  (`services.gateway.publicURL`, …), not by any platform-specific mechanism.
- **Persistence.** PostgreSQL, Neo4j, and Qdrant need durable volumes. The KB's `.semiont/events/`
  directory is the **system of record** and must survive container replacement.
- **The KB working tree.** The Archivist bind-mounts the KB repo at `/kb`. On a multi-node scheduler
  that means a shared filesystem or a different content strategy.
- **Ingress and TLS.** The Browser serves on 3000 and the gateway on 4000; terminating TLS and
  routing to them is platform work.
- **Migrations.** The gateway applies Prisma migrations at startup; no external migration step is
  required, but the database must be reachable before the gateway becomes healthy.
- **Restart and liveness.** Each image runs `tini` as PID 1 wrapping a single service process, and
  the container exits when that process dies, so your platform's restart policy and liveness probe
  behave as they normally would. Nothing restarts anything from inside the container on this path,
  and nothing needs to be disabled.

Platform notes, including a fuller ECS Fargate checklist:
[platforms/AWS.md](../platforms/AWS.md).

---

## Verifying a deployment

Independent of how you ran it:

```bash
curl http://<gateway-host>:4000/api/health     # gateway health
curl http://<browser-host>:3000/              # UI reachable
```

`semiont status` reports per-service health for launcher-managed stacks. For log and trace plumbing
see [OBSERVABILITY.md](./OBSERVABILITY.md); for failure triage see
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
