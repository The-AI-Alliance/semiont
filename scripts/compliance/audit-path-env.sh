#!/usr/bin/env bash
set -euo pipefail

# Audit: path environment census (P1–P3). A service is told where its
# directories are through its environment, by whatever mounted them. A path
# composed as `process.env.X ?? <default>` is a path nobody chose: inside a
# container the default has no mount behind it, so what is written there is
# lost when the container stops, and in a test run it is the developer's own
# home. Absence fails loudly instead.
#
# P1  every read of an XDG_* variable or of TMPDIR, in non-test source under
#     packages/*/src and apps/*/src, is in the list below with its reason.
# P2  no such read has a fallback on its line (`??`, `||`, `unwrap_or`).
# P3  every entry of the list is still a read. An entry nothing reads is a
#     reason given for something that is not there.
#
# The launcher (apps/launcher) is not in scope: it runs on a person's machine,
# where the XDG defaults are real places, and it has its own tests of them.
#
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

FAIL=0

# "file VAR — reason".
READS="
packages/core/src/project.ts XDG_STATE_HOME — the root of a service's state tree; stateDirFor throws when it is unset
"

is_test_file() { echo "$1" | grep -qE '__tests__|/test-setup|\.test\.[a-z]+$|vitest\.setup|/tests/'; }

# Every line that reads the environment and names one of the variables:
# `process.env.X`, `process.env['X']`, a destructuring from `process.env`,
# and Rust's `env::var("X")`.
found=$(grep -rnIE '(process\.env|env::var(_os)?\()' packages/*/src apps/*/src 2>/dev/null \
  | grep -vE '^apps/launcher/' \
  | grep -E '\b(XDG_[A-Z_]+|TMPDIR)\b' || true)

seen=""
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  file="${hit%%:*}"
  rest="${hit#*:}"
  line="${rest%%:*}"
  text="${rest#*:}"
  if is_test_file "$file"; then continue; fi
  for var in $(echo "$text" | grep -oE '\b(XDG_[A-Z_]+|TMPDIR)\b' | sort -u); do
    seen="$seen$file $var
"
    if ! echo "$READS" | grep -qE "^$file $var "; then
      echo "❌ P1: $file:$line reads \$$var and the list in this audit does not name it. Add it with its reason, or take the path from what the service is handed."
      FAIL=1
    fi
    if echo "$text" | grep -qE '\?\?|\|\||unwrap_or'; then
      echo "❌ P2: $file:$line gives \$$var a fallback. A path with no mount behind it is written to and lost; fail when the variable is unset."
      FAIL=1
    fi
  done
done <<< "$found"

while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  key="${entry%% — *}"
  if ! echo "$seen" | grep -qxF "$key"; then
    echo "❌ P3: the list names \"$key\", and nothing reads it. Remove the entry."
    FAIL=1
  fi
done <<< "$READS"

if [ "$FAIL" -eq 0 ]; then
  echo "✅ path environment census clean (P1 every XDG_*/TMPDIR read listed, P2 none has a fallback, P3 every listed read exists)"
fi
exit "$FAIL"
