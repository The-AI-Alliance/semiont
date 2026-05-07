FROM rust:1.95-bookworm

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

RUN cargo install tauri-cli
