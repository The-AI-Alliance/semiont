# The smelter image: the Smelter service (images/smelter, Python) and the three
# packages of this repository it runs on, built here from the repository, in
# an environment of exactly what images/smelter/uv.lock pins, with the program
# that reads a scanned page beside it. Nothing is built, installed or fetched
# when the container starts: the entrypoint runs the service.
#
# Built from the repository root, on the oldest Python the repository's Python
# packages support, which packages/python/sdk/pyproject.toml states
# (requires-python), the one place it is written:
#
#   --build-arg PYTHON_FLOOR=$(packages/python/scripts/python-floor.sh)
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
# The SDK, the vector stores and what every Python service is built on are
# this repository's, and no index holds the version the service is written
# against: each is built from its manifest, the README its manifest names,
# where it names one, and its source.
COPY packages/python/sdk/pyproject.toml packages/python/sdk/README.md packages/python/sdk/
COPY packages/python/sdk/src packages/python/sdk/src
COPY packages/python/vectors/pyproject.toml packages/python/vectors/README.md packages/python/vectors/
COPY packages/python/vectors/src packages/python/vectors/src
COPY packages/python/service/pyproject.toml packages/python/service/
COPY packages/python/service/src packages/python/service/src
COPY images/smelter/pyproject.toml images/smelter/uv.lock images/smelter/
COPY images/smelter/src images/smelter/src
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
# No extra is named, since semiont-smelter has none: the vector index and the
# embedding providers are asked over HTTP, with what every install has.
#
# PDFium, which reads a PDF, comes in the wheel of its binding (pypdfium2),
# built for Alpine's C library with its C++ runtime inside it. It asks for no
# package of the system, in this stage or the next.
RUN uv sync --project images/smelter --locked --no-dev --no-editable

FROM python:${PYTHON_FLOOR}-alpine
# Patch base-image OS packages so Alpine's security fixes apply even when the
# base's snapshot has not been rebuilt against them yet. With tini, what reads
# a scanned page, each as Alpine packages it:
#
#   tesseract-ocr           the `tesseract` program, which the Smelter runs
#                           once for each image of a page that has no text of
#                           its own (semiont_smelter.tesseract). It is found
#                           on the path.
#   tesseract-ocr-data-eng  the English data the program is run with. The
#                           program finds it where Alpine installs it, and
#                           reading a page reaches no network.
RUN apk upgrade --no-cache && apk add --no-cache tini tesseract-ocr tesseract-ocr-data-eng
# Nothing is installed in the image once it is built, so it carries no
# installer.
RUN pip uninstall --yes --root-user-action=ignore pip

# The uid every service image runs as. The Smelter mounts nothing: the
# anchored-text store is the Archivist's, kept over its HTTP surface.
RUN addgroup --system --gid 1001 semiont && \
    adduser --system --uid 1001 --ingroup semiont --home /home/semiont semiont

COPY --from=builder /opt/venv /opt/venv

COPY LICENSE images/smelter/NOTICE /home/semiont/
COPY images/shared/supervise.sh /usr/local/bin/supervise.sh
COPY images/shared/boot.sh /usr/local/bin/boot.sh

WORKDIR /kb
RUN chown semiont:semiont /kb

USER semiont

# `python` is the environment's.
ENV PATH=/opt/venv/bin:$PATH
EXPOSE 24101

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:24101/health || exit 1

ENV SUPERVISE_NAME=smelter \
    SUPERVISE_PROBE=http://localhost:24101/health
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/boot.sh"]
# --config names where the launcher mounts the Smelter's document; the
# launcher's census (TestConfigDocumentsAreWhereTheImagesLook) reads it here.
# `-P` keeps the working directory off the import path: a file in /kb is never
# a module the service imports.
CMD ["python", "-P", "-m", "semiont_smelter", "--config", "/etc/semiont/smelter.json"]
