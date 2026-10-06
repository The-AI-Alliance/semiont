# The builder image of the desktop app's Linux bundles: Rust, the libraries
# Tauri links, and the Tauri CLI.
#
# Its Rust is the toolchain rust-toolchain.toml names — the one place it is
# written. build.sh passes it:
#
#   --build-arg RUST_TOOLCHAIN=$(scripts/ci/rust-toolchain.sh)
#
# There is no default: without it the FROM names no image and the build
# stops, rather than building with a toolchain nothing pinned.
ARG RUST_TOOLCHAIN

FROM rust:${RUST_TOOLCHAIN}-bookworm

RUN apt-get update -qq && \
    apt-get install -y -qq \
      libgtk-3-dev \
      libwebkit2gtk-4.1-dev \
      libappindicator3-dev \
      librsvg2-dev \
      patchelf \
      pkg-config \
      xdg-utils \
      > /dev/null 2>&1 && \
    rm -rf /var/lib/apt/lists/*

ARG TAURI_CLI_VERSION
RUN cargo install tauri-cli --version "${TAURI_CLI_VERSION:?build.sh passes the version package-lock.json pins}" --locked
