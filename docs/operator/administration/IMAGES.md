# Container Images

The container images this repository publishes, how they are tagged, and how to verify one before you run it. What each service does and needs is in [the service catalog](../services/OVERVIEW.md).

## Overview

Eight images are published to GitHub Container Registry, as `ghcr.io/the-ai-alliance/<image>`, for `linux/amd64` and `linux/arm64`:

`semiont-gateway`, `semiont-dispatcher`, `semiont-archivist`, `semiont-librarian`, `semiont-worker`, `semiont-smelter`, `semiont-weaver` and `semiont-browser`.

**Configuration is given at run time, never built in.** No image contains anything about a knowledge base, so one verified image serves every knowledge base, and a knowledge base's repository builds no image of its own. The launcher runs the image a knowledge base's documents name for each service, `ghcr.io/the-ai-alliance/semiont-<service>:latest` as `semiont init` writes them, and mounts each service's configuration into it. The Browser is the machine's: it runs `ghcr.io/the-ai-alliance/semiont-browser:latest` unless `semiont settings browser-image` names another ([Configuration](CONFIGURATION.md#images)).

---

## semiont-browser

[![ghcr](https://img.shields.io/badge/ghcr-latest-blue)](https://github.com/The-AI-Alliance/semiont/pkgs/container/semiont-browser)

The Semiont Browser: a single-page app served by a small static-file server.

**Pull image:**
```bash
docker pull ghcr.io/the-ai-alliance/semiont-browser:latest
```

**Environment variables:** `PORT` only (default `3000`). The container holds
no knowledge-base configuration and mounts none: the app connects to knowledge
bases from the person's web browser (see [HUMAN-UI.md](../../architecture/HUMAN-UI.md)).

**Documentation:** [images/browser/README.md](../../../images/browser/README.md)

**Source:** [images/browser/](../../../images/browser/)

**Dockerfile:** [images/browser/Dockerfile](../../../images/browser/Dockerfile)

**Workflow:** [.github/workflows/publish-browser.yml](../../../.github/workflows/publish-browser.yml)

---

## The service images

[![ghcr](https://img.shields.io/badge/ghcr-latest-blue)](https://github.com/orgs/The-AI-Alliance/packages?repo_name=semiont)

One is Node: the Browser. It installs the published `@semiont/browser` npm package at the image's own version, so the image's version is always the npm version it carries. Its Dockerfile's `FROM` names its base.

Three are Rust: the gateway, the dispatcher and the Archivist. Each image compiles its binary from the commit it is published from and ships it on `alpine`, with no source and no toolchain, and builds or fetches nothing when it starts. The Archivist's also carries `git`, which it stages a knowledge base's changes with.

Four are Python: the worker, the weaver, the smelter and the librarian. Each image is built from the commit it is published from too: the service in `images/worker`, `images/weaver`, `images/smelter` or `images/librarian` and the Python packages of the repository it runs on, in an environment of exactly what its `uv.lock` pins, on the oldest Python those packages support. It carries no installer and no Node, and installs or fetches nothing when it starts. The weaver's carries every graph database's client. The librarian's carries every graph database's client and every model provider's library. The smelter's carries the `tesseract` program with its English data, which reads a scanned page, and PDFium, which reads a PDF. **The worker's carries every model provider's library**, so one image serves whichever provider a knowledge base names, of the seven the protocol lists. Building an image with one provider's library alone is one changed line: see [the worker's README](../../../images/worker/README.md#a-slimmer-image).

| Image | Built from | Dockerfile |
|---|---|---|
| `semiont-gateway` | Rust, `images/gateway` | [images/gateway/Dockerfile](../../../images/gateway/Dockerfile) |
| `semiont-dispatcher` | Rust, `images/dispatcher` | [images/dispatcher/Dockerfile](../../../images/dispatcher/Dockerfile) |
| `semiont-archivist` | Rust, `images/archivist` | [images/archivist/Dockerfile](../../../images/archivist/Dockerfile) |
| `semiont-librarian` | Python, `images/librarian` | [images/librarian/Dockerfile](../../../images/librarian/Dockerfile) |
| `semiont-smelter` | Python, `images/smelter` | [images/smelter/Dockerfile](../../../images/smelter/Dockerfile) |
| `semiont-weaver` | Python, `images/weaver` | [images/weaver/Dockerfile](../../../images/weaver/Dockerfile) |
| `semiont-worker` | Python, `images/worker` | [images/worker/Dockerfile](../../../images/worker/Dockerfile) |

Each one's port, configuration and dependencies are in [the service catalog](../services/OVERVIEW.md).

The Browser has its own workflow, [publish-browser.yml](../../../.github/workflows/publish-browser.yml); the seven services share [publish-service-images.yml](../../../.github/workflows/publish-service-images.yml). How a release is published is in the contributor's [Release Process](../../contributor/RELEASE.md), and building all eight from a checkout is in [Local Development](../../contributor/LOCAL-DEVELOPMENT.md).

---

## Versioning

Every image carries the same version, the one in [`version.json`](../../../version.json), and gets these tags:

- **The version**, such as `<version>` for a release or `<version>-build.<n>` for a development build.
- **The commit**: `sha-<commit>`, the short SHA the image was built from.
- **`latest`**, moved to a release when it is promoted. It is what `semiont init` names in a new knowledge base's documents, and what the Browser runs unless `semiont settings browser-image` names another.

A tag can be moved; a digest cannot. To pin exactly what you verified, reference the image by digest.

---

## Supply-Chain Verification

Every image published to GHCR — the Browser and all seven service
images — carries two cryptographic attestations stored as OCI
artifacts alongside the image:

- **Build provenance** — SLSA-style attestation tying the image
  digest to the GitHub Actions workflow run, commit SHA, and
  workflow inputs. Signed via Sigstore using a short-lived
  certificate issued by Fulcio against the workflow's OIDC token.
- **SBOM** (Software Bill of Materials) — SPDX 2.3 listing of all
  OS packages and language libraries in the image, generated by
  Trivy at build time and signed the same way.

Each image is also scanned by Trivy for `HIGH` and `CRITICAL`
vulnerabilities before it is pushed. A finding that has a fix available
fails the publish, so such an image never reaches the registry. The
service images pass a licence policy as well.

### What `semiont start` checks

Before it tears down or runs anything, `semiont start` verifies each of Semiont's images that it is about to run: the services' images the knowledge base's documents name, and the Browser's.

- It reads the image's digest from its registry, and the build provenance attested of that digest. GHCR keeps an image's attestations under the tag `sha256-<digest>`.
- It checks the attestation's signature against Sigstore's public trusted root, which it reads through TUF and keeps under the launcher's data directory until the root's metadata expires.
- The signer must be GitHub Actions running this repository's publish workflow for that image, `publish-browser.yml` for the Browser and `publish-service-images.yml` for the seven services, at a release tag (`refs/tags/v…`). An image built from a branch, by another workflow or from another repository is refused.

A verified image is pulled and run by its digest, `name:tag@sha256:<digest>`, so a tag moved afterwards changes nothing that runs. An image that does not verify does not run, and the start stops before it touches the stack that is running.

An image tagged `:local` is built on this machine and never pulled, so no release vouches for it. It runs unverified, and every start names it in a warning: it is for development only.

### Verify the image you pulled

Requires the [GitHub CLI](https://cli.github.com/). No keys to
manage — verification uses Sigstore's transparency log.

The signer is the one `semiont start` requires: the image's publish
workflow of `The-AI-Alliance/semiont`, at the release's tag.

```bash
# The Browser
gh attestation verify \
  oci://ghcr.io/the-ai-alliance/semiont-browser:VERSION \
  --repo The-AI-Alliance/semiont \
  --cert-identity https://github.com/The-AI-Alliance/semiont/.github/workflows/publish-browser.yml@refs/tags/vVERSION

# <image> is any of the seven services': semiont-gateway, semiont-archivist,
# semiont-librarian, semiont-worker, semiont-smelter, semiont-weaver,
# semiont-dispatcher
gh attestation verify \
  oci://ghcr.io/the-ai-alliance/<image>:VERSION \
  --repo The-AI-Alliance/semiont \
  --cert-identity https://github.com/The-AI-Alliance/semiont/.github/workflows/publish-service-images.yml@refs/tags/vVERSION
```

`--cert-identity` holds the signer to one workflow at one tag. `--owner`
accepts any workflow of any repository in the organization, and
`--signer-workflow` any workflow whose path begins with the one named, at
any ref: both pass images `semiont start` refuses.

A successful verification confirms:

1. The image digest you pulled matches the digest the workflow
   built and pushed.
2. The image was built from `The-AI-Alliance/semiont` by its publish
   workflow, run at the tag `vVERSION`, from the commit and with the
   inputs recorded in the attestation.
3. The signing certificate was issued by Sigstore's Fulcio CA to
   that workflow's OIDC identity.

If verification fails, **do not run the image** — it has been
tampered with, was published outside the official workflow, or the
attestations were stripped.

### Inspecting the SBOM

The SBOM attestation is itself an OCI artifact, signed by the same
workflow as the build provenance. Verify it under the same signer, by its
predicate type, and print the SPDX document it carries (for the Browser,
its own workflow, as above):

```bash
gh attestation verify \
  oci://ghcr.io/the-ai-alliance/<image>:VERSION \
  --repo The-AI-Alliance/semiont \
  --cert-identity https://github.com/The-AI-Alliance/semiont/.github/workflows/publish-service-images.yml@refs/tags/vVERSION \
  --predicate-type https://spdx.dev/Document \
  --format json --jq '.[0].verificationResult.statement.predicate'
```

`gh attestation download` fetches attestations without checking who
signed them.

The document lists every package in the image with version,
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