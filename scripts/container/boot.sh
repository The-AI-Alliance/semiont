#!/bin/sh
# boot.sh — the shared image entrypoint, exec'd by tini as PID 1
# (ORCHESTRATOR-NATIVE-IMAGES D1/D3). The image CMD arrives as "$@" — the
# single statement of what this image runs, in both modes (D4).
#
# SEMIONT_SUPERVISE (set by the launcher, for local placement only) chooses
# per RUN: non-empty wraps the command in the shared supervisor; unset runs
# it directly, so a published image behaves like a conventional container —
# one process, exits when it dies, restarted by the caller's own policy.
if [ -n "${SEMIONT_SUPERVISE:-}" ]; then
  exec /bin/sh /usr/local/bin/supervise.sh "$@"
fi
exec "$@"
