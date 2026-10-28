# @semiont Applications

The applications that run on a host rather than in a container. The services that ship as
container images are in [images/](../images/README.md).

## Host-installed binaries

| App | Source | Distribution | Description |
| --- | ------ | ------------ | ----------- |
| `semiont` launcher | [launcher](./launcher/) | `brew install the-ai-alliance/semiont/semiont` (also [GitHub Releases](https://github.com/The-AI-Alliance/semiont/releases)) | Single static Go binary that runs a local KB stack — pulls the published images and drives Apple `container`, Docker, or Podman directly (`semiont start` / `status` / `logs` / `stop`) |
| Semiont Desktop | [desktop](./desktop/) | [GitHub Releases](https://github.com/The-AI-Alliance/semiont/releases) (macOS, Linux) | Native [Tauri](https://tauri.app/) shell around the Semiont Browser SPA — no container runtime to install and no local-network permission to grant |
