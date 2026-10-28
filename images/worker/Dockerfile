# The worker image: the Worker service (images/worker, Python) and the three
# packages of this repository it runs on, built here from the repository, in
# an environment of exactly what images/worker/uv.lock pins. Nothing is built,
# installed or fetched when the container starts: the entrypoint runs the
# service.
#
# Built from the repository root, on the oldest Python the repository's Python
# packages support, which packages/sdk-python/pyproject.toml states
# (requires-python), the one place it is written:
#
#   --build-arg PYTHON_FLOOR=$(scripts/ci/python-floor.sh)
#
# There is no default: without it a FROM names no image and the build stops,
# rather than building on a Python nothing pinned.
ARG PYTHON_FLOOR

# uv makes the environment, in the builder stage alone.
FROM ghcr.io/astral-sh/uv:0.13.6 AS uv

FROM python:${PYTHON_FLOOR}-alpine AS builder
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /build
# Each package below takes its version from version.json when it is built.
COPY version.json ./
# The SDK, the inference drivers and what every Python service is built on
# are this repository's, and no index holds the version the service is written
# against: each is built from its manifest, the README its manifest names,
# where it names one, and its source.
COPY packages/sdk-python/pyproject.toml packages/sdk-python/README.md packages/sdk-python/
COPY packages/sdk-python/src packages/sdk-python/src
COPY packages/inference-python/pyproject.toml packages/inference-python/README.md packages/inference-python/
COPY packages/inference-python/src packages/inference-python/src
COPY packages/service-python/pyproject.toml packages/service-python/
COPY packages/service-python/src packages/service-python/src
COPY images/worker/pyproject.toml images/worker/uv.lock images/worker/
COPY images/worker/src images/worker/src
# The environment is made on this stage's Python and no other, with its
# bytecode written here: the image's user cannot write it. uv keeps no cache,
# and the stage mounts none: from a cache that outlives a build, uv installs
# the wheel it built of a package's earlier sources when only its sources have
# changed since.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_NO_CACHE=1 \
    UV_COMPILE_BYTECODE=1
# What the lockfile pins and nothing else: --locked refuses a lockfile that no
# longer agrees with the manifests, --no-dev leaves the checkers and the tests'
# tools out, and --no-editable installs the four packages above as built
# wheels, so the environment is whole without this stage's tree.
#
# --all-extras is every provider's library: each extra of semiont-worker
# brings the inference drivers' extra of the same name, and with it the
# library that provider is asked through. An image for one provider names
# that provider's extra in its place (`--extra anthropic`), and one for Ollama
# alone names none: Ollama is asked with what every install has.
RUN uv sync --project images/worker --locked --no-dev --no-editable --all-extras

FROM python:${PYTHON_FLOOR}-alpine
# Patch base-image OS packages so Alpine's security fixes apply even when the
# base's snapshot has not been rebuilt against them yet.
RUN apk upgrade --no-cache && apk add --no-cache tini
# Nothing is installed in the image once it is built, so it carries no
# installer.
RUN pip uninstall --yes --root-user-action=ignore pip

# The uid the launcher's state mount is written as, as in every service image.
RUN addgroup --system --gid 1001 semiont && \
    adduser --system --uid 1001 --ingroup semiont --home /home/semiont semiont

COPY --from=builder /opt/venv /opt/venv

# Typst renderer for PDF generation. Pinned to the
# version whose PDF text-layer geometry was measured — the recorded citation
# geometry is a property of this version's layout. Alpine/musl build, same
# libc as this base. The binary embeds its default Latin fonts (Libertinus,
# SIL OFL), which covers en/es/de/fr with no separate font files; non-Latin
# scripts have no font in this image. Every
# invocation must pin --creation-timestamp — unpinned compiles change bytes on
# identical input, which churns content checksums and re-embeds forever
# (smelter axioms S11/S12).
# Attribution lives in NOTICE (Apache-2.0 + the embedded font licenses, which
# no scanner can see inside a bare binary) — bump the version there in the
# same diff as this tag.
COPY --from=ghcr.io/typst/typst:0.15.1 /bin/typst /usr/local/bin/typst

COPY LICENSE images/worker/NOTICE /home/semiont/

# The model catalogue: what models.dev says each model of Google, OpenAI and
# Together can take, which those providers' own APIs do not say. A model of one
# of them is asked with these facts, and the service's document names this
# path (modelCatalogue). It is the repository's one generated copy, made by
# scripts/inference/generate-model-catalogue.mjs from the npm package
# package.json pins, and held to that pin by CI's drift job. Nothing is fetched
# to build it here. Its licence notice goes with it.
COPY packages/inference-python/tests/catalogue/model-catalogue.json /usr/share/semiont/model-catalogue.json
COPY packages/inference-python/tests/catalogue/model-catalogue.LICENSE /usr/share/semiont/model-catalogue.LICENSE
COPY scripts/container/supervise.sh /usr/local/bin/supervise.sh
COPY scripts/container/boot.sh /usr/local/bin/boot.sh

WORKDIR /kb
RUN chown semiont:semiont /kb

USER semiont

# `python` is the environment's.
ENV PATH=/opt/venv/bin:$PATH
EXPOSE 24100

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:24100/health || exit 1

ENV SUPERVISE_NAME=worker \
    SUPERVISE_PROBE=http://localhost:24100/health
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/boot.sh"]
# --config names where the launcher mounts the worker's document; the
# launcher's census (TestConfigDocumentsAreWhereTheImagesLook) reads it here.
# `-P` keeps the working directory off the import path: a file in /kb is never
# a module the service imports.
CMD ["python", "-P", "-m", "semiont_worker", "--config", "/etc/semiont/worker.json"]
