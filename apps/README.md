# @semiont Applications

Deployable applications for the Semiont platform.

## Published npm packages

| Package | Version | Source | Description |
| ------- | ------- | ------ | ----------- |
| [@semiont/gateway](https://www.npmjs.com/package/@semiont/gateway) | [![npm](https://img.shields.io/npm/v/@semiont/gateway)](https://www.npmjs.com/package/@semiont/gateway) | [gateway](./gateway/) | Hono API server + event-bus gateway |
| [@semiont/browser](https://www.npmjs.com/package/@semiont/browser) | [![npm](https://img.shields.io/npm/v/@semiont/browser)](https://www.npmjs.com/package/@semiont/browser) | [browser](./browser/) | Vite + React SPA — the Semiont Browser |

The backend and Browser also ship as published, attested container images
(`ghcr.io/the-ai-alliance/semiont-{backend,browser}`) that bundle these
packages — see [Container Images](../docs/system/administration/IMAGES.md).

## Host-installed binaries

| App | Source | Distribution | Description |
| --- | ------ | ------------ | ----------- |
| `semiont` launcher | [launcher](./launcher/) | `brew install the-ai-alliance/semiont/semiont` (also [GitHub Releases](https://github.com/The-AI-Alliance/semiont/releases)) | Single static Go binary that runs a local KB stack — pulls the published images and drives Apple `container`, Docker, or Podman directly (`semiont start` / `status` / `logs` / `stop`) |
| Semiont Desktop | [desktop](./desktop/) | [GitHub Releases](https://github.com/The-AI-Alliance/semiont/releases) (macOS, Linux) | Native [Tauri](https://tauri.app/) shell around the Semiont Browser SPA — no container runtime to install and no local-network permission to grant |
