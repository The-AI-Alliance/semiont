ARG GHC_VERSION
FROM haskell:${GHC_VERSION} AS toolchain
FROM debian:bookworm-slim
RUN apt-get update && apt-get install --yes --no-install-recommends \
    python3 build-essential libgmp-dev libnuma-dev libtinfo6 zlib1g-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=toolchain /opt/ghc /opt/ghc
COPY --from=toolchain /usr/local/bin/cabal /usr/local/bin/cabal
ARG GHC_VERSION
ENV PATH="/opt/ghc/${GHC_VERSION}/bin:${PATH}"
WORKDIR /work/packages/haskell/probes
