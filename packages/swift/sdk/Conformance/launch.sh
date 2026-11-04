#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$root/profiles"
export LD_LIBRARY_PATH="$root/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# Rust's profiles use another LLVM version. Keep this driver's measurement separate.
export LLVM_PROFILE_FILE="$root/profiles/%m-%p.profraw"
exec "$root/bin/SemiontWireDriver" "$@"
