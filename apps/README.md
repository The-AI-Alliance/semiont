# @semiont Applications

The applications that run on a host rather than in a container. The services that ship as
container images are in [images/](../images/README.md). Nothing here is published as an image;
the desktop app is packaged for macOS by Electron Builder.

## Host-installed binaries

| App | Source | Distribution | Description |
| --- | ------ | ------------ | ----------- |
| `semiont` launcher | [launcher](./launcher/) | `brew install the-ai-alliance/semiont/semiont` (also [GitHub Releases](https://github.com/The-AI-Alliance/semiont/releases)) | Single static Go binary that runs a local KB stack — pulls the published images and drives Apple `container`, Docker, or Podman directly (`semiont start` / `status` / `logs` / `stop`). Its libraries are [packages/go/launcher](../packages/go/launcher/README.md) |
| Semiont Desktop | [desktop](./desktop/) | [GitHub Releases](https://github.com/The-AI-Alliance/semiont/releases) (macOS Apple Silicon, Linux x64 `.deb`) | Native [Electron](https://www.electronjs.org/) Semiont chat client |
