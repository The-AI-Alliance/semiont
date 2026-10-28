# The Archivist image: the binary, built here from the repository, and nothing
# of its source — no .rs, no Cargo files, no target/, no toolchain, no specs/
# (the spec is compiled into the binary), and no Node. Nothing is built,
# installed or fetched when the container starts: the entrypoint execs the binary.
#
# Built from the repository root, with the toolchain
# rust-toolchain.toml names — the one place it is written:
#
#   --build-arg RUST_TOOLCHAIN=$(scripts/ci/rust-toolchain.sh)
#
# There is no default: without it the first FROM names no image and the build
# stops, rather than building with a toolchain nothing pinned.
ARG RUST_TOOLCHAIN

FROM rust:${RUST_TOOLCHAIN}-alpine AS builder
# make builds jemalloc, the allocator tikv-jemalloc-sys compiles into the binary.
RUN apk add --no-cache make
# cargo-auditable writes the crates the binary links into the binary itself,
# which is how the image scan (Trivy) sees them in an image with no Cargo.lock.
RUN cargo install cargo-auditable --locked --version 0.7.6
WORKDIR /build
COPY version.json ./
COPY specs/src specs/src
# The workspace (Cargo.toml at the repository root): cargo loads every member
# to build any one of them, so each member's crate is copied.
COPY Cargo.toml Cargo.lock ./
COPY images/archivist/Cargo.toml images/archivist/
COPY images/archivist/src images/archivist/src
COPY images/archivist/record/Cargo.toml images/archivist/record/
COPY images/archivist/record/src images/archivist/record/src
COPY images/archivist/staging/Cargo.toml images/archivist/staging/
COPY images/archivist/staging/src images/archivist/staging/src
COPY images/gateway/Cargo.toml images/gateway/
COPY images/gateway/src images/gateway/src
COPY images/dispatcher/Cargo.toml images/dispatcher/
COPY images/dispatcher/src images/dispatcher/src
COPY images/dispatcher/handlers/Cargo.toml images/dispatcher/handlers/
COPY images/dispatcher/handlers/src images/dispatcher/handlers/src
COPY images/dispatcher/jetstream/Cargo.toml images/dispatcher/jetstream/build.rs images/dispatcher/jetstream/
COPY images/dispatcher/jetstream/src images/dispatcher/jetstream/src
COPY packages/codegen-rust/Cargo.toml packages/codegen-rust/
COPY packages/codegen-rust/src packages/codegen-rust/src
COPY packages/core-rust/Cargo.toml packages/core-rust/build.rs packages/core-rust/
COPY packages/core-rust/src packages/core-rust/src
COPY packages/http-service-rust/Cargo.toml packages/http-service-rust/
COPY packages/http-service-rust/src packages/http-service-rust/src
COPY packages/http-transport-rust/Cargo.toml packages/http-transport-rust/
COPY packages/http-transport-rust/src packages/http-transport-rust/src
COPY packages/http-transport-rust/conformance/Cargo.toml packages/http-transport-rust/conformance/
COPY packages/http-transport-rust/conformance/src packages/http-transport-rust/conformance/src
COPY packages/observability-rust/Cargo.toml packages/observability-rust/
COPY packages/observability-rust/src packages/observability-rust/src
COPY packages/sdk-rust/Cargo.toml packages/sdk-rust/build.rs packages/sdk-rust/
COPY packages/sdk-rust/src packages/sdk-rust/src
# The SDK's build script reads the spec through its own `specs`, a link in the
# repository: made here, where only what is named is copied.
RUN ln -s ../../specs/src packages/sdk-rust/specs
COPY packages/telemetry-rust/Cargo.toml packages/telemetry-rust/
COPY packages/telemetry-rust/src packages/telemetry-rust/src
# The builder stage is the same in each Rust service's Dockerfile
# (lint:rust-images): it builds every service's binary, so an image built
# after, or beside, another reuses its stage instead of compiling the
# workspace again. A spec that does not compile fails here, in the build
# scripts, never at boot.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo auditable build --release --locked -p semiont-archivist -p semiont-dispatcher -p semiont-gateway && \
    cp target/release/semiont-archivist target/release/semiont-dispatcher target/release/semiont-gateway /

FROM alpine:3.24
# git is the Archivist's staging driver's: a knowledge base that syncs git has
# its changes staged with it, and this is the one image that runs it. The
# mounted knowledge base is owned by a host uid that need not be this image's
# user, and git refuses a tree whose owner is not the caller's
# (CVE-2022-24765) unless told to trust it; --system writes /etc/gitconfig,
# which applies to every user.
RUN apk upgrade --no-cache && apk add --no-cache tini git && \
    git config --system --add safe.directory /kb

# The uid the launcher's state mount is written as, as in every service image.
RUN addgroup --system --gid 1001 semiont && \
    adduser --system --uid 1001 --ingroup semiont --home /home/semiont semiont

COPY --from=builder /semiont-archivist /usr/local/bin/semiont-archivist
COPY LICENSE images/archivist/NOTICE /home/semiont/
COPY scripts/container/supervise.sh /usr/local/bin/supervise.sh
COPY scripts/container/boot.sh /usr/local/bin/boot.sh

# The knowledge base is mounted here, and is where git is run.
WORKDIR /kb
RUN chown semiont:semiont /kb

USER semiont

EXPOSE 24103

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:24103/health || exit 1

ENV SUPERVISE_NAME=archivist \
    SUPERVISE_PROBE=http://localhost:24103/health
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/boot.sh"]
# --config names where the launcher mounts the Archivist's document; the
# launcher's census (TestConfigDocumentsAreWhereTheImagesLook) reads it here.
CMD ["/usr/local/bin/semiont-archivist", "--config", "/etc/semiont/archivist.json"]
