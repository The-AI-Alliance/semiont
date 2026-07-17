# Container Images

This document is an inventory of the container images published from
this repository.

## Overview

This repo publishes **5 container images** to GitHub Container Registry
(ghcr.io):

- **semiont-frontend** — Vite + React SPA (the Semiont Browser), served as a
  static container.
- **semiont-backend** — the API server + unified bus gateway.
- **semiont-worker** — the annotation/generation worker pool.
- **semiont-smelter** — the embedding/vector pipeline actor.
- **semiont-weaver** — the graph-projection actor.

Knowledge-base repositories **pull these images — they do not build their
own**. A KB's `.semiont/` compose files reference
`ghcr.io/the-ai-alliance/semiont-<svc>:${SEMIONT_VERSION:-latest}` and
bind-mount per-KB TOML config at runtime; nothing KB-specific is baked into
any image. See
[semiont-template-kb](https://github.com/The-AI-Alliance/semiont-template-kb)
for the canonical consuming stack (`start.sh` pulls all five and starts them
alongside the infrastructure containers).

All images support `linux/amd64` and `linux/arm64` and follow the
unified versioning scheme managed through [`version.json`](../../../version.json).

---

## semiont-frontend

[![ghcr](https://img.shields.io/badge/ghcr-latest-blue)](https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-frontend)

**Description:** Vite + React single-page app (the Semiont Browser),
served from a Node static-file server. Multi-platform: `linux/amd64`,
`linux/arm64`.

**Pull image:**
```bash
docker pull ghcr.io/the-ai-alliance/semiont-frontend:latest
```

**Environment variables:** `PORT` only (default `3000`). The container is a
static-file server with no backend config and no config mount — the SPA
connects to knowledge bases from the *browser* at runtime (the multi-KB
session model; see [HUMAN-UI.md](../HUMAN-UI.md)).

**Documentation:** [apps/frontend/README.md](../../../apps/frontend/README.md)

**Source:** [apps/frontend/](../../../apps/frontend/)

**Dockerfile:** [apps/frontend/Dockerfile](../../../apps/frontend/Dockerfile)

**Workflow:** [.github/workflows/publish-frontend.yml](../../../.github/workflows/publish-frontend.yml)

---

## The service images

[![ghcr](https://img.shields.io/badge/ghcr-latest-blue)](https://github.com/orgs/The-AI-Alliance/packages?repo_name=semiont)

The four backend-side services are published as runtime images that
**bundle the published `@semiont/*` npm packages** at the requested version —
the publish workflow refuses to build until the matching packages exist on
npm (`npm view` gate), so an image version always equals the npm version it
carries. All four run `node:24-alpine` (the frontend runs `node:26-alpine`).

| Image | What runs | Bundled packages | Port | Dockerfile |
|---|---|---|---|---|
| `semiont-backend` | API server + bus gateway (role driven through the CLI) | `@semiont/cli`, `@semiont/backend` | 4000 | [apps/backend/Dockerfile](../../../apps/backend/Dockerfile) |
| `semiont-worker` | annotation/generation worker pool | `@semiont/jobs` | 9090 | [packages/jobs/Dockerfile](../../../packages/jobs/Dockerfile) |
| `semiont-smelter` | embedding/vector pipeline actor | `@semiont/make-meaning` | 9091 | [packages/make-meaning/Dockerfile.smelter](../../../packages/make-meaning/Dockerfile.smelter) |
| `semiont-weaver` | graph-projection actor | `@semiont/make-meaning` | 9092 | [packages/make-meaning/Dockerfile.weaver](../../../packages/make-meaning/Dockerfile.weaver) |

**Configuration is runtime, not build-time.** The images contain no KB
config; consuming stacks bind-mount their per-service TOML at run time.
This is what lets one attested image serve every knowledge base — KB repos
carry no Dockerfiles and no image builds of their own.

**Workflow:** [.github/workflows/publish-service-images.yml](../../../.github/workflows/publish-service-images.yml)
(a matrix over the four services).

**Local dev loop:** [scripts/ci/local-build.sh](../../../scripts/ci/local-build.sh)
builds all five images from the working tree as
`ghcr.io/the-ai-alliance/semiont-<svc>:local` (via a throwaway local
verdaccio; never pushed), fanning each built image out to every other
container engine on the machine so any `--runtime` finds them. A KB stack
consumes them with `SEMIONT_VERSION=local`, which also skips the pull.

---

## Versioning

All images follow the unified versioning system managed through
[`version.json`](../../../version.json). Every published image gets one
or more of the following tags:

- **Version tag** — the `version` input to the workflow, e.g. `0.4.22`
  for stable releases or `0.4.22-build.42` for dev builds.
- **Commit tag** — `sha-{COMMIT}`, where `{COMMIT}` is the short SHA
  of the commit that triggered the workflow.
- **Latest tag** — `latest`, applied only when the workflow is run
  with `tag_latest=true`. Operators pinning to `:latest` get whatever
  the most recent stable promotion was.

### Publishing Process

Two workflows publish the images, both triggered manually with the desired
version: [`publish-frontend.yml`](../../../.github/workflows/publish-frontend.yml)
(the frontend) and
[`publish-service-images.yml`](../../../.github/workflows/publish-service-images.yml)
(a matrix over backend, worker, smelter, weaver). Each run, per image:

1. Verifies the matching `@semiont/*` npm package version(s) exist —
   the image bundles published packages, never the working tree.
2. Builds the multi-platform image from the service's Dockerfile.
3. Trivy-scans the amd64 build for `HIGH`/`CRITICAL` CVEs (and, for
   the service images, license-policy violations) and fails the run
   on any unfixed finding.
4. Pushes the image to GHCR with three tags: the version, a
   `sha-{COMMIT}` tag, and (optionally) `latest`.
5. Generates an SPDX SBOM and publishes both build-provenance and
   SBOM attestations as OCI artifacts alongside the image.

### Manual publishing

```bash
gh workflow run publish-frontend.yml --field version=0.5.13
gh workflow run publish-service-images.yml --field version=0.5.13
# common flags for either workflow:
gh workflow run publish-service-images.yml --field version=0.5.13 --field dry_run=true
gh workflow run publish-service-images.yml --field version=0.5.13 --field tag_latest=true
```

---

## Supply-Chain Verification

Every image published to GHCR — the frontend and all four service
images — carries two cryptographic attestations stored as OCI
artifacts alongside the image:

- **Build provenance** — SLSA-style attestation tying the image
  digest to the GitHub Actions workflow run, commit SHA, and
  workflow inputs. Signed via Sigstore using a short-lived
  certificate issued by Fulcio against the workflow's OIDC token.
- **SBOM** (Software Bill of Materials) — SPDX 2.3 listing of all
  OS packages and language libraries in the image, generated by
  Trivy at build time and signed the same way.

The image itself is also Trivy-scanned for `HIGH`/`CRITICAL`
vulnerabilities before push; an image with unfixed HIGH/CRITICAL
findings will fail the publish workflow rather than reach the
registry.

### Verify the image you pulled

Requires the [GitHub CLI](https://cli.github.com/). No keys to
manage — verification uses Sigstore's transparency log.

```bash
# <image> is any of: semiont-frontend, semiont-backend, semiont-worker,
# semiont-smelter, semiont-weaver
gh attestation verify \
  oci://ghcr.io/the-ai-alliance/<image>:VERSION \
  --owner The-AI-Alliance
```

A successful verification confirms:

1. The image digest you pulled matches the digest the workflow
   built and pushed.
2. The image was built from `The-AI-Alliance/semiont` at a specific
   commit, by its publish workflow, with the inputs recorded in
   the attestation.
3. The signing certificate was issued by Sigstore's Fulcio CA to
   that workflow's OIDC identity.

If verification fails, **do not run the image** — it has been
tampered with, was published outside the official workflow, or the
attestations were stripped.

### Inspecting the SBOM

The SBOM attestation is itself an OCI artifact. To download and
inspect:

```bash
gh attestation download \
  oci://ghcr.io/the-ai-alliance/<image>:VERSION \
  --owner The-AI-Alliance \
  --predicate-type https://spdx.dev/Document
```

The downloaded JSON lists every package in the image with version,
license, and supplier — useful for vulnerability triage when a CVE
lands and you need to know whether your running image contains the
affected package.

---

## Registry Links

- **Container images:** https://github.com/orgs/The-AI-Alliance/packages?repo_name=semiont
- **GitHub Releases:** https://github.com/The-AI-Alliance/semiont/releases

---

## Support

For issues related to container images:
- **Bug reports:** https://github.com/The-AI-Alliance/semiont/issues
- **Security issues:** See [SECURITY.md](./SECURITY.md)
- **General questions:** https://github.com/The-AI-Alliance/semiont/discussions