#!/usr/bin/env bash
# Sourced by the local build session.

# --- What is kept between runs, kept bounded ---
#
# Each tool keeps what it downloads and compiles, and none of them forgets a
# version it no longer needs: npm's and uv's caches, Go's module cache, cargo's
# registry and Gradle's home each hold every version a run ever fetched, and Go
# trims its build cache only as it runs. So each directory is held to one size: one over it is
# emptied, and the next run fetches or compiles what it needs again.
CACHE_LIMIT_KB=$((8 * 1024 * 1024))
banner "CACHES"
for cache in "$NPM_CACHE_DIR" "$GOCACHE_DIR" "$GOMODCACHE_DIR" "$UVCACHE_DIR" "$CARGO_REGISTRY_DIR" "$GRADLE_HOME_DIR"; do
  used=$(du -sk "$cache" 2>/dev/null | cut -f1)
  if [[ "${used:-0}" -gt "$CACHE_LIMIT_KB" ]]; then
    # Go writes its module cache read-only.
    chmod -R u+w "$cache" 2>/dev/null || true
    find "$cache" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
    warn "${cache/#$HOME/~} held $((used / 1024)) MB, over $((CACHE_LIMIT_KB / 1024)) MB: emptied"
  else
    echo -e "  ${DIM}${cache/#$HOME/~}: $((${used:-0} / 1024)) MB${RESET}"
  fi
done
