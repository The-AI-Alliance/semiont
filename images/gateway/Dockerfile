# The gateway image: the binary, built here from the repository, and nothing
# of its source — no .rs, no Cargo files, no target/, no toolchain, no specs/
# (the spec is compiled into the binary). Nothing is built, installed or
# fetched when the container starts: the entrypoint execs the binary.
#
# Built from the repository root, with the toolchain
# rust-toolchain.toml names — the one place it is written:
#
#   --build-arg RUST_TOOLCHAIN=$(packages/rust/scripts/rust-toolchain.sh)
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
# The workspace (packages/rust/Cargo.toml): cargo loads every member
# to build any one of them, so each member's crate is copied.
COPY packages/rust/Cargo.toml packages/rust/Cargo.lock packages/rust/
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
COPY packages/rust/codegen/Cargo.toml packages/rust/codegen/
COPY packages/rust/codegen/src packages/rust/codegen/src
COPY packages/rust/core/Cargo.toml packages/rust/core/build.rs packages/rust/core/
COPY packages/rust/core/src packages/rust/core/src
COPY packages/rust/http-service/Cargo.toml packages/rust/http-service/
COPY packages/rust/http-service/src packages/rust/http-service/src
COPY packages/rust/http-transport/Cargo.toml packages/rust/http-transport/
COPY packages/rust/http-transport/src packages/rust/http-transport/src
COPY packages/rust/http-transport/conformance/Cargo.toml packages/rust/http-transport/conformance/
COPY packages/rust/http-transport/conformance/src packages/rust/http-transport/conformance/src
COPY packages/rust/observability/Cargo.toml packages/rust/observability/
COPY packages/rust/observability/src packages/rust/observability/src
COPY packages/rust/sdk/Cargo.toml packages/rust/sdk/build.rs packages/rust/sdk/
COPY packages/rust/sdk/src packages/rust/sdk/src
# The SDK's build script reads the spec through its own `specs`, a link in the
# repository: made here, where only what is named is copied.
RUN ln -s ../../../specs/src packages/rust/sdk/specs
COPY packages/rust/telemetry/Cargo.toml packages/rust/telemetry/
COPY packages/rust/telemetry/src packages/rust/telemetry/src
# The builder stage is the same in each Rust service's Dockerfile
# (lint:rust-images): it builds every service's binary, so an image built
# after, or beside, another reuses its stage instead of compiling the
# workspace again. A spec that does not compile fails here, in the build
# scripts, never at boot.
WORKDIR /build/packages/rust
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/packages/rust/target \
    cargo auditable build --release --locked -p semiont-archivist -p semiont-dispatcher -p semiont-gateway && \
    cp target/release/semiont-archivist target/release/semiont-dispatcher target/release/semiont-gateway /

FROM alpine:3.24
RUN apk upgrade --no-cache && apk add --no-cache tini

# The uid the launcher's state mount is written as, as in every service image.
RUN addgroup --system --gid 1001 semiont && \
    adduser --system --uid 1001 --ingroup semiont --home /home/semiont semiont

COPY --from=builder /semiont-gateway /usr/local/bin/semiont-gateway
COPY LICENSE images/gateway/NOTICE /home/semiont/
COPY images/shared/supervise.sh /usr/local/bin/supervise.sh
COPY images/shared/boot.sh /usr/local/bin/boot.sh

USER semiont

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:4000/api/health || exit 1

ENV SUPERVISE_NAME=gateway \
    SUPERVISE_PROBE=http://localhost:4000/api/health
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/boot.sh"]
# --config names where the launcher mounts the gateway's document; the
# launcher's census (TestConfigDocumentsAreWhereTheImagesLook) reads it here.
CMD ["/usr/local/bin/semiont-gateway", "--config", "/etc/semiont/gateway.json"]
