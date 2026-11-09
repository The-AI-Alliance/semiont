ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install --yes --no-install-recommends \
    python3 build-essential pkg-config libgmp-dev libssl-dev openssl ca-certificates git curl \
    && rm -rf /var/lib/apt/lists/*
USER opam
COPY --chown=opam:opam toolchain.json /tmp/semiont-ocaml-toolchain.json
RUN python3 - <<'PYTHON'
import json
import subprocess
pins = json.load(open('/tmp/semiont-ocaml-toolchain.json'))
actual = subprocess.check_output(['opam', 'exec', '--', 'ocamlc', '-version'], text=True).strip()
if actual != pins['ocaml']:
    raise SystemExit(f"OCaml compiler mismatch: expected {pins['ocaml']}, got {actual}")
subprocess.run(['opam', 'repository', 'set-url', '--yes', 'default',
    'git+https://github.com/ocaml/opam-repository.git#' + pins['opamRepository']], check=True)
subprocess.run(['opam', 'install', '--yes', 'dune.' + pins['dune']], check=True)
PYTHON
USER root
WORKDIR /work/packages/ocaml/sdk
ENTRYPOINT ["opam", "exec", "--root", "/home/opam/.opam", "--"]
