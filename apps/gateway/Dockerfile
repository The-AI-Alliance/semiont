# The gateway image: the binary, built here from the repository, and nothing
# of its source — no .rs, no Cargo files, no target/, no toolchain, no specs/
# (the spec is compiled into the binary). Nothing is built, installed or
# fetched when the container starts: the entrypoint execs the binary.
#
# Built from the repository root, with the toolchain
# apps/gateway/rust-toolchain.toml names — the one place it is written:
#
#   --build-arg RUST_TOOLCHAIN=$(sed -n 's/^channel = "\(.*\)"$/\1/p' apps/gateway/rust-toolchain.toml)
#
# There is no default: without it the first FROM names no image and the build
# stops, rather than building with a toolchain nothing pinned.
ARG RUST_TOOLCHAIN

FROM rust:${RUST_TOOLCHAIN}-alpine AS builder
# cargo-auditable writes the crates the binary links into the binary itself,
# which is how the image scan (Trivy) sees them in an image with no Cargo.lock.
RUN cargo install cargo-auditable --locked --version 0.7.6
WORKDIR /build
COPY version.json ./
COPY specs/src specs/src
COPY apps/gateway/Cargo.toml apps/gateway/Cargo.lock apps/gateway/build.rs apps/gateway/
COPY apps/gateway/src apps/gateway/src
WORKDIR /build/apps/gateway
# A spec that does not compile fails here, in build.rs, never at boot.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/apps/gateway/target \
    cargo auditable build --release --locked && \
    cp target/release/semiont-gateway /semiont-gateway

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
CMD ["/usr/local/bin/semiont-gateway"]
