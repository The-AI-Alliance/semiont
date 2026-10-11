# The weaver image: the Weaver service (apps/weaver, Python) and the two
# packages of this repository it runs on, built here from the repository, in
# an environment of exactly what apps/weaver/uv.lock pins. Nothing is built,
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
FROM ghcr.io/astral-sh/uv:0.13.0 AS uv

FROM python:${PYTHON_FLOOR}-alpine AS builder
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /build
# Each package below takes its version from version.json when it is built.
COPY version.json ./
# The SDK and the graph stores are this repository's, and no index holds the
# version the service is written against: each is built from its manifest,
# the README its manifest names, and its source.
COPY packages/sdk-python/pyproject.toml packages/sdk-python/README.md packages/sdk-python/
COPY packages/sdk-python/src packages/sdk-python/src
COPY packages/graph-python/pyproject.toml packages/graph-python/README.md packages/graph-python/
COPY packages/graph-python/src packages/graph-python/src
COPY apps/weaver/pyproject.toml apps/weaver/uv.lock apps/weaver/
COPY apps/weaver/src apps/weaver/src
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
# tools out, and --no-editable installs the three packages above as built
# wheels, so the environment is whole without this stage's tree.
#
# --all-extras is every graph database's client: each extra of semiont-weaver
# brings the graph stores' extra of the same name, and with it the client
# that database is asked through. An image for one database names that
# database's extra in its place (`--extra neo4j`).
RUN uv sync --project apps/weaver --locked --no-dev --no-editable --all-extras

FROM python:${PYTHON_FLOOR}-alpine
# Patch base-image OS packages so Alpine's security fixes apply even when the
# base's snapshot has not been rebuilt against them yet.
RUN apk upgrade --no-cache && apk add --no-cache tini
# Nothing is installed in the image once it is built, so it carries no
# installer.
RUN pip uninstall --yes --root-user-action=ignore pip

# The uid every service image runs as.
RUN addgroup --system --gid 1001 semiont && \
    adduser --system --uid 1001 --ingroup semiont --home /home/semiont semiont

COPY --from=builder /opt/venv /opt/venv

COPY LICENSE apps/weaver/NOTICE /home/semiont/
COPY scripts/container/supervise.sh /usr/local/bin/supervise.sh
COPY scripts/container/boot.sh /usr/local/bin/boot.sh

WORKDIR /kb
RUN chown semiont:semiont /kb

USER semiont

# `python` is the environment's.
ENV PATH=/opt/venv/bin:$PATH
EXPOSE 24102

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:24102/health || exit 1

ENV SUPERVISE_NAME=weaver \
    SUPERVISE_PROBE=http://localhost:24102/health
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/boot.sh"]
# --config names where the launcher mounts the Weaver's document; the
# launcher's census (TestConfigDocumentsAreWhereTheImagesLook) reads it here.
# `-P` keeps the working directory off the import path: a file in /kb is never
# a module the service imports.
CMD ["python", "-P", "-m", "semiont_weaver", "--config", "/etc/semiont/weaver.json"]
