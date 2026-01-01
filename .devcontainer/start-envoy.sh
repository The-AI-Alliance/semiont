#!/bin/bash
# Simple wrapper to start Envoy in a truly detached manner

# Redirect all output to dedicated log file
exec > /tmp/envoy.log 2>&1

# Close stdin
exec < /dev/null

# Start Envoy
exec envoy -c /workspace/.devcontainer/envoy.yaml
