#!/bin/sh
set -eu
mkdir -p .build
find . -path './.build' -prune -o -name '*.swift' -type f -print > .build/census-files
while IFS= read -r file; do
  if grep -nE '@unchecked[[:space:]]+Sendable|nonisolated[[:space:]]*\(unsafe\)|@preconcurrency|swift-format-ignore' "$file"; then exit 1; fi
  case "$file" in ./Sources/*)
    if sed -E 's/ProcessInfo\.processInfo\.environment\["SEMIONT_BUS_LOG"\]//g; s/getenv\("SEMIONT_BUS_LOG"\)//g' "$file" | grep -nE '\.environment|getenv[[:space:]]*\('; then exit 1; fi
    if grep -nE '\b(setenv|unsetenv|putenv|environ)\b' "$file"; then exit 1; fi;;
  esac
done < .build/census-files
if grep -nE 'unsafeFlags|swiftLanguageMode[[:space:]]*\(|treatWarning[[:space:]]*\(' Package.swift; then exit 1; fi
swift format dump-configuration > .build/default-format.json
# The formatter owns the vocabulary; every rule must be stated.
sed -n '/"rules"/,/^  }/p' .build/default-format.json | sed -n 's/.*"\([^"]*\)" : .*/\1/p' | sort > .build/default-rules
sed -n '/"rules"/,/^  }/p' .swift-format | sed -n 's/.*"\([^"]*\)" : .*/\1/p' | sort > .build/our-rules
diff -u .build/default-rules .build/our-rules
for rule in NeverForceUnwrap NeverUseForceTry NeverUseImplicitlyUnwrappedOptionals; do
  grep -E "\"$rule\" : true" .swift-format > /dev/null
done
echo "census: concurrency, environment, compiler settings and format rules checked"
