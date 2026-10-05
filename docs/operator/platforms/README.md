# Where a stack runs

Every Semiont service runs as a Linux container. What differs from place to place is who starts the containers.

## With the launcher

The [`semiont` launcher](../../../apps/launcher/README.md) runs a stack on these systems, for `arm64` and `amd64`:

| System | Container runtime | Notes |
|---|---|---|
| macOS | Apple `container`, Docker Desktop or Podman | [Running a local stack](../LOCAL-SEMIONT.md) |
| Linux | Docker or Podman | [Running a local stack](../LOCAL-SEMIONT.md) |
| Windows | Docker Desktop, on its WSL2 backend | [Semiont on Windows](WINDOWS.md): inside WSL2, or as `semiont.exe` |
| GitHub Codespaces | Docker, inside the codespace | `semiont start --runtime codespace`, from any of the above: [Knowledge Bases](../../KNOWLEDGE-BASES.md) |

`--runtime` names the runtime for one command, and `semiont settings runtime` sets it for the machine.

## On a platform of your own

Kubernetes, OpenShift, a cloud's container service, or machines on your own premises: the launcher is not involved, and the deployment is yours to write. [Deploying Semiont](../administration/DEPLOYMENT.md#your-own-platform) states what each image needs and what the platform must provide.
