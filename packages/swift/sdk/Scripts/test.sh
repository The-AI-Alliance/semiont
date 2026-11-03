#!/bin/sh
set -eu
# SwiftPM's automatic JSON export includes dependency coverage and exceeds its output limit.
# Build instrumented tests, then run them without asking SwiftPM to export that JSON.
swift build --jobs 4 --build-tests --enable-code-coverage
mkdir -p .build/unit-profiles
find .build/unit-profiles -name '*.profraw' -type f -delete
LLVM_PROFILE_FILE="$PWD/.build/unit-profiles/%m-%p.profraw" swift test --skip-build
