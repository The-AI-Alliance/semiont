# Operating Semiont

How to run a Semiont stack: deploying, configuring, securing, observing and troubleshooting it.

For how Semiont works inside, see **[../architecture/](../architecture/)**.
For protocol-level concerns (channels, flows, W3C compliance), see **[../protocol/](../protocol/)**.
For working in a knowledge base, see **[../analyst/](../analyst/)**.
For contributor workflow, see **[../contributor/](../contributor/)**.

## Operations

Day-2 concerns — deploying, securing, observing, scaling, troubleshooting:

- **[administration/](administration/)** — `AUTHENTICATION.md`, `AUTHORIZATION` / RBAC, `SECURITY.md`, `DEPLOYMENT.md`, `CONFIGURATION.md`, `OBSERVABILITY.md`, `BACKUP.md`, `IMAGES.md`, `MAINTENANCE.md`, `SCALING.md`, `TROUBLESHOOTING.md`
- **[platforms/](platforms/)** — how stacks are run, and `AWS.md` for scheduling the images yourself
- **[services/](services/)** — service catalog: `OVERVIEW.md`, `SECRETS.md`
- **[CONTAINER-TOPOLOGY.md](CONTAINER-TOPOLOGY.md)** — how a deployment splits into containers and how they communicate

## Project layout & local-run

- **[PROJECT-LAYOUT.md](PROJECT-LAYOUT.md)** — `.semiont/config` and the project-anchor convention.
- **[LOCAL-GATEWAY.md](LOCAL-GATEWAY.md)** — running the full local stack with the `semiont` launcher: start, useradd, logs, status, stop.
- **[LOCAL-SEMIONT.md](LOCAL-SEMIONT.md)** — installing and running Semiont locally; per-platform local-network notes the browser container needs.

## Cross-references

- **[../protocol/](../protocol/)** — the eight flows, the event-bus protocol, the OpenAPI reference, the W3C compliance story, agent skills.
- **[../../packages/README.md](../../packages/README.md)** — alphabetized inventory of all `@semiont/*` workspace packages with one-line descriptions.
- **[../../CONTRIBUTING.md](../../CONTRIBUTING.md)** — branch/PR workflow, commit conventions.
- **[../contributor/](../contributor/README.md)** — codebase orientation for new contributors.
