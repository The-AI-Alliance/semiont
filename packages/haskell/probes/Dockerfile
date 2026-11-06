ARG GHC_VERSION
FROM haskell:${GHC_VERSION} AS toolchain
FROM debian:trixie-slim
RUN apt-get update && apt-get install --yes --no-install-recommends \
    python3 build-essential binutils-gold libgmp-dev libnuma-dev libtinfo6 zlib1g-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=toolchain /opt/ghc /opt/ghc
COPY cabal-install.version cabal-install.sha256 /tmp/
RUN python3 - <<'PYTHON'
import hashlib
from pathlib import Path
import platform
import tarfile
import urllib.request

version = Path('/tmp/cabal-install.version').read_text().strip()
archive = f'cabal-install-{version}-{platform.machine()}-linux-unknown.tar.xz'
checksums = {name: digest for digest, name in
             (line.split() for line in Path('/tmp/cabal-install.sha256').read_text().splitlines())}
expected = checksums[archive]
url = f'https://github.com/haskell/cabal/releases/download/cabal-install-v{version}/{archive}'
urllib.request.urlretrieve(url, '/tmp/cabal.tar.xz')
if hashlib.sha256(Path('/tmp/cabal.tar.xz').read_bytes()).hexdigest() != expected:
    raise SystemExit('Cabal release checksum mismatch')
with tarfile.open('/tmp/cabal.tar.xz') as release:
    executable = release.extractfile('cabal')
    if executable is None:
        raise SystemExit('Cabal release has no executable')
    Path('/usr/local/bin/cabal').write_bytes(executable.read())
Path('/usr/local/bin/cabal').chmod(0o755)
Path('/tmp/cabal.tar.xz').unlink()
PYTHON
ARG GHC_VERSION
ENV PATH="/opt/ghc/${GHC_VERSION}/bin:${PATH}"
WORKDIR /work/packages/haskell/probes
