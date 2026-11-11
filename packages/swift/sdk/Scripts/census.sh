#!/bin/sh
set -eu
mkdir -p .build
find . -path './.build' -prune -o -name '*.swift' -type f -print > .build/census-files
while IFS= read -r file; do
  if grep -nE '@unchecked[[:space:]]+Sendable|nonisolated[[:space:]]*\(unsafe\)|@preconcurrency|swift-format-ignore' "$file"; then exit 1; fi
  case "$file" in ./Sources/*)
    if sed -E 's/ProcessInfo\.processInfo\.environment\["SEMIONT_BUS_LOG"\]//g; s/getenv\("SEMIONT_BUS_LOG"\)//g' "$file" | grep -nE '\.environment|getenv[[:space:]]*\('; then exit 1; fi
    if grep -nE '\b(setenv|unsetenv|putenv|environ)\b' "$file"; then exit 1; fi
    # Every wait and interval keeps the clock its caller gives, and every jitter draws from the
    # caller's random source; the system's are their default arguments alone. A secret (the PKCE
    # verifier and state) stays the system's secure source.
    if sed -E 's/: any Clock<Duration> = ContinuousClock\(\)//g; s/: any RandomNumberGenerator & Sendable = SystemRandomNumberGenerator\(\)//g; s/var secret = SystemRandomNumberGenerator\(\)//g' "$file" | grep -nE 'ContinuousClock|SuspendingClock|SystemRandomNumberGenerator|Task\.sleep|asyncAfter|DispatchTime|Thread\.sleep'; then exit 1; fi
    if grep -nE '\.random\(|\.randomElement\(|\.shuffled?\(' "$file" | grep -v 'using:'; then exit 1; fi
    # AsyncHTTPClient keeps no deadline: each is the SDK's own wait, on the caller's clock.
    if grep -nE '\.execute\(' "$file" | grep -v 'deadline: \.distantFuture'; then exit 1; fi
    # Every task starts at the one spawn point, which keeps the executor a test binds; a function
    # that returns a task is not one starting.
    case "$file" in ./Sources/Semiont/Transport/Spawn.swift) ;; *)
      if sed -E 's/-> Task<[^{]*\{//g' "$file" | grep -nE '(^|[^[:alnum:]_])Task(\.detached|\.immediate)?[[:space:]]*(<[^>]*>)?[[:space:]]*[({]'; then exit 1; fi;;
    esac;;
  # A test's wait is bounded by testDeadlineMs alone, which withinTestDeadline keeps.
  ./Tests/SemiontTests/TestDeadline.swift) ;;
  ./Tests/*)
    if grep -nE '(^|[^[:alnum:]_])within\(' "$file"; then exit 1; fi;;
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
echo "census: concurrency, environment, clock and random source, test deadlines, compiler settings and format rules checked"
