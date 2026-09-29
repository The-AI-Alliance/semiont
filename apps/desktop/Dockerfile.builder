FROM rust:1.98-bookworm

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
