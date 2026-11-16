#!/usr/bin/env bash
set -euo pipefail

# Audit: Weaver structural invariants G1–G5 (WEAVER-AXIOMS.md "Design
# constraints"). These are the invariants that hold by construction and
# cannot be expressed as runtime properties — the static complement of the
# weaver-axioms.test.ts suite.
#
# G1  weaver.ts has no event-store or fs attachment (history via browse:* only)
# G2  the Weaver is standalone-only (constructed in weaver-main + tests only)
# G3  the applied mark has a single writer (noteApplied + the catch-up seed)
# G4  weave:applied has a single emitter (noteApplied)
# G5  the fan-in channel list and the fold's switch cases stay in sync
#
# Exit code: 0 if clean, 1 if violations found.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

WEAVER="packages/make-meaning/src/weaver.ts"
UNIT="packages/make-meaning/src/weaver-actor-state-unit.ts"
FAIL=0

# ── G1 — no event-store / fs attachment ─────────────────────────────────────
G1=$(grep -nE "@semiont/event-sourcing|from ['\"](node:)?fs['\"]" "$WEAVER" || true)
if [ -n "$G1" ]; then
  echo "❌ G1: weaver.ts must read history over browse:* only — no event-store or fs imports:"
  echo "$G1"
  FAIL=1
fi
# Entry points (weaver-main: TOML config bootstrap, like smelter-main) and
# tests (tmp dirs) are exempt — the invariant governs the runtime modules.
G1B=$(grep -rlnE "from ['\"](node:)?fs['\"]" packages/make-meaning/src \
  --include='weaver*.ts' 2>/dev/null \
  | grep -vE "weaver-checkpoint\.ts|weaver-main\.ts|/__tests__/" || true)
if [ -n "$G1B" ]; then
  echo "❌ G1: only weaver-checkpoint.ts may touch the filesystem among weaver files:"
  echo "$G1B"
  FAIL=1
fi

# ── G2 — standalone-only construction ───────────────────────────────────────
G2=$(grep -rn "new Weaver(" packages apps --include='*.ts' 2>/dev/null \
  | grep -vE "/node_modules/|/dist/|/__tests__/|weaver-main\.ts" || true)
if [ -n "$G2" ]; then
  echo "❌ G2: the Weaver is standalone-only (D4) — constructed in weaver-main.ts and tests, nowhere else:"
  echo "$G2"
  FAIL=1
fi
G2B=$(grep -rnE "kb\.weaver\b|weaverEvents" packages apps --include='*.ts' 2>/dev/null \
  | grep -vE "/node_modules/|/dist/" || true)
if [ -n "$G2B" ]; then
  echo "❌ G2: kb.weaver / weaverEvents must not exist — the backend keeps only the weaveProgress fold:"
  echo "$G2B"
  FAIL=1
fi

# ── G3 — single writer for the applied mark ─────────────────────────────────
G3_COUNT=$(grep -c "lastProcessed.set(" "$WEAVER" || true)
if [ "$G3_COUNT" -ne 2 ]; then
  echo "❌ G3: expected exactly 2 lastProcessed.set sites in weaver.ts (noteApplied + catch-up seed), found $G3_COUNT:"
  grep -n "lastProcessed.set(" "$WEAVER" || true
  FAIL=1
fi

# ── G4 — single emitter for weave:applied ───────────────────────────────────
G4_COUNT=$(grep -c "emit('weave:applied'" "$WEAVER" || true)
if [ "$G4_COUNT" -ne 1 ]; then
  echo "❌ G4: expected exactly 1 weave:applied emit site in weaver.ts (noteApplied), found $G4_COUNT:"
  grep -n "weave:applied" "$WEAVER" || true
  FAIL=1
fi

# ── G5 — fan-in channels ≡ fold switch cases ────────────────────────────────
CHANNELS=$(sed -n "/export const WEAVER_CHANNELS = \[/,/\] as const;/p" "$UNIT" \
  | grep -oE "'[a-z]+:[a-z-]+'" | tr -d "'" | sort -u)
CASES=$(grep -oE "case '(yield|mark|frame):[a-z-]+'" "$WEAVER" \
  | grep -oE "'[a-z]+:[a-z-]+'" | tr -d "'" | sort -u)
if [ "$CHANNELS" != "$CASES" ]; then
  echo "❌ G5: WEAVER_CHANNELS and the applyEventToGraph switch have drifted"
  echo "   (the smelter-misses-unarchive bug class — a subscribed channel with no fold, or a fold no one feeds):"
  echo "   channels only: $(comm -23 <(echo "$CHANNELS") <(echo "$CASES") | tr '\n' ' ')"
  echo "   cases only:    $(comm -13 <(echo "$CHANNELS") <(echo "$CASES") | tr '\n' ' ')"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
echo "✅ Weaver invariants G1–G5 hold"
