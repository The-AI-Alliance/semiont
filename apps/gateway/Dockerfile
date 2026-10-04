# The gateway image: the binary, built here from the repository, and nothing
# of its source — no .rs, no Cargo files, no target/, no toolchain, no specs/
# (the spec is compiled into the binary). Nothing is built, installed or
# fetched when the container starts: the entrypoint execs the binary.
#
# Built from the repository root, with the toolchain
# rust-toolchain.toml names — the one place it is written:
#
#   --build-arg RUST_TOOLCHAIN=$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)
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
COPY apps/gateway/Cargo.toml apps/gateway/
COPY apps/gateway/src apps/gateway/src
COPY apps/dispatcher/Cargo.toml apps/dispatcher/
COPY apps/dispatcher/src apps/dispatcher/src
COPY apps/dispatcher/handlers/Cargo.toml apps/dispatcher/handlers/
COPY apps/dispatcher/handlers/src apps/dispatcher/handlers/src
COPY apps/dispatcher/jetstream/Cargo.toml apps/dispatcher/jetstream/build.rs apps/dispatcher/jetstream/
COPY apps/dispatcher/jetstream/src apps/dispatcher/jetstream/src
COPY packages/codegen-rust/Cargo.toml packages/codegen-rust/
COPY packages/codegen-rust/src packages/codegen-rust/src
COPY packages/core-rust/Cargo.toml packages/core-rust/build.rs packages/core-rust/
COPY packages/core-rust/src packages/core-rust/src
COPY packages/http-transport-rust/Cargo.toml packages/http-transport-rust/
COPY packages/http-transport-rust/src packages/http-transport-rust/src
COPY packages/http-transport-rust/conformance/Cargo.toml packages/http-transport-rust/conformance/
COPY packages/http-transport-rust/conformance/src packages/http-transport-rust/conformance/src
COPY packages/observability-rust/Cargo.toml packages/observability-rust/
COPY packages/observability-rust/src packages/observability-rust/src
COPY packages/sdk-rust/Cargo.toml packages/sdk-rust/build.rs packages/sdk-rust/
COPY packages/sdk-rust/src packages/sdk-rust/src
COPY packages/telemetry-rust/Cargo.toml packages/telemetry-rust/
COPY packages/telemetry-rust/src packages/telemetry-rust/src
# The builder stage is the same in each Rust service's Dockerfile
# (lint:rust-images): it builds every service's binary, so an image built
# after, or beside, another reuses its stage instead of compiling the
# workspace again. A spec that does not compile fails here, in the build
# scripts, never at boot.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo auditable build --release --locked -p semiont-dispatcher -p semiont-gateway && \
    cp target/release/semiont-dispatcher target/release/semiont-gateway /

FROM alpine:3.24
RUN apk upgrade --no-cache && apk add --no-cache tini

# The uid the launcher's state mount is written as, as in every service image.
RUN addgroup --system --gid 1001 semiont && \
    adduser --system --uid 1001 --ingroup semiont --home /home/semiont semiont

COPY --from=builder /semiont-gateway /usr/local/bin/semiont-gateway
COPY LICENSE apps/gateway/NOTICE /home/semiont/
COPY scripts/container/supervise.sh /usr/local/bin/supervise.sh
COPY scripts/container/boot.sh /usr/local/bin/boot.sh

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
