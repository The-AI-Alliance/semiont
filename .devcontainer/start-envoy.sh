#!/bin/bash
# Wrapper to start Envoy as a proper daemon using double-fork

# First fork: Create intermediate process
(
  # Close file descriptors inherited from parent
  exec </dev/null
  exec >/tmp/envoy.log 2>&1

  # Second fork: Create the actual daemon (will be reparented to init)
  (
    # Start Envoy - this process will be reparented to PID 1 (init)
    exec envoy -c /workspace/.devcontainer/envoy.yaml
  ) &

  # Exit intermediate process immediately
  exit 0
) &

# Exit wrapper immediately - the double-forked Envoy is now a daemon
exit 0
