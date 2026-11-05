#!/bin/sh
set -eu
mkdir -p .build/refusals
clean() { sed -E 's/\[[0-9;]*[mK]//g; s/\]8;;[^]*\\//g'; }
if swift build --jobs 4 --force-resolved-versions -Xswiftc -DSEMIONT_SENDABLE_CANARY --scratch-path .build/canary > .build/refusals/canary.log 2>&1; then
  echo "Sendable canary compiled" >&2; exit 1
fi
clean < .build/refusals/canary.log > .build/refusals/clean.log
expected=$(sed -n '1s@// refused: @@p' Sources/Semiont/SendableCanary.swift)
sed -n 's/^.*error: //p' .build/refusals/clean.log | grep -F "$expected" > /dev/null
if grep -F '; this is an error in the Swift 6 language mode' .build/refusals/clean.log; then exit 1; fi
bin=$(swift build --force-resolved-versions --show-bin-path)
test -d "$bin"
find .build/out/Intermediates.noindex -path '*/GeneratedModuleMaps*/*' -name 'C*.modulemap' -type f > .build/refusals/modulemaps
find .build/checkouts/*/Sources -path '*/include/module.modulemap' -type f >> .build/refusals/modulemaps
set -- -typecheck -swift-version 6 -warnings-as-errors -I "$bin"
if [ "$(uname -s)" = Darwin ]; then
  set -- "$@" -sdk "$(xcrun --sdk macosx --show-sdk-path)"
fi
while IFS= read -r map; do set -- "$@" -Xcc "-fmodule-map-file=$map"; done < .build/refusals/modulemaps
for file in Refusals/*.swift; do
  [ -f "$file" ] || continue
  expected=$(sed -n '1s@// refused: @@p' "$file")
  test -n "$expected"
  if swiftc "$@" "$file" > .build/refusals/program.log 2>&1; then
    echo "$file compiled" >&2; exit 1
  fi
  clean < .build/refusals/program.log | sed -n 's/^.*error: //p' | grep -F "$expected" > /dev/null
done
echo "refusals: canary and every refusal rejected as expected"
