#!/bin/sh
# Export both compiled test libraries, without SwiftPM's dependency-sized JSON report.
set -eu
bin=$(swift build --force-resolved-versions --show-bin-path)
llvm-profdata merge -sparse .build/unit-profiles/*.profraw -o .build/unit-profiles/default.profdata
set --
for product in "$bin/"*Tests.so; do
  test -f "$product"
  set -- "$@" -object "$product"
done
test "$#" -gt 0
llvm-cov export -format=lcov -instr-profile=.build/unit-profiles/default.profdata "$@" \
  -ignore-filename-regex='(/Tests/|/\.build/)' > .build/coverage.lcov
test -s .build/coverage.lcov
