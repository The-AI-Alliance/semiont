# The dispatcher image: the binary, built here from the repository, and nothing
# of its source — no .rs, no Cargo files, no target/, no toolchain, no specs/
# (the spec is compiled into the binary), and no Node. Nothing is built,
# installed or fetched when the container starts: the entrypoint execs the binary.
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
COPY packages/sdk-rust/Cargo.toml packages/sdk-rust/build.rs packages/sdk-rust/
COPY packages/sdk-rust/src packages/sdk-rust/src
# A spec that does not compile fails here, in the build scripts, never at boot.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo auditable build --release --locked -p semiont-dispatcher && \
    cp target/release/semiont-dispatcher /semiont-dispatcher

FROM alpine:3.24
RUN apk upgrade --no-cache && apk add --no-cache tini

# The uid the launcher's state mount is written as, as in every service image.
RUN addgroup --system --gid 1001 semiont && \
    adduser --system --uid 1001 --ingroup semiont --home /home/semiont semiont

COPY --from=builder /semiont-dispatcher /usr/local/bin/semiont-dispatcher
COPY LICENSE apps/dispatcher/NOTICE /home/semiont/
COPY scripts/container/supervise.sh /usr/local/bin/supervise.sh
COPY scripts/container/boot.sh /usr/local/bin/boot.sh

USER semiont

EXPOSE 24105

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:24105/health || exit 1

ENV SUPERVISE_NAME=dispatcher \
    SUPERVISE_PROBE=http://localhost:24105/health
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/boot.sh"]
# --config names where the launcher mounts the dispatcher's document; the
# launcher's census (TestConfigDocumentsAreWhereTheImagesLook) reads it here.
CMD ["/usr/local/bin/semiont-dispatcher", "--config", "/etc/semiont/dispatcher.json"]
