#!/bin/sh
# swift test's single JSON report is overwritten by the second test product.
# Export both compiled test libraries with the merged profile instead.
set -eu
bin=$(swift build --show-bin-path)
cov="$bin/codecov"
test -s "$cov/default.profdata"
set --
for product in "$bin/"*Tests.so; do
  test -f "$product"
  set -- "$@" -object "$product"
done
test "$#" -gt 0
llvm-cov export -format=lcov -instr-profile="$cov/default.profdata" "$@" \
  -ignore-filename-regex='(/Tests/|/\.build/)' > .build/coverage.lcov
test -s .build/coverage.lcov
