#!/usr/bin/env bash
# Select a responding engine without starting services or pulling images.
runtime_ready() {
  local runtime="$1" probe watcher result
  if [[ "$runtime" == container ]]; then
    "$runtime" system status >/dev/null 2>&1 &
  else
    "$runtime" info >/dev/null 2>&1 &
  fi
  probe=$!
  (sleep 5; kill -KILL "$probe" >/dev/null 2>&1) >/dev/null 2>&1 &
  watcher=$!
  result=0
  wait "$probe" 2>/dev/null || result=$?
  kill "$watcher" >/dev/null 2>&1 || true
  wait "$watcher" 2>/dev/null || true
  return "$result"
}

runtime_start_instruction() {
  case "$1" in
    container) echo 'Start it with: container system start' ;;
    docker)
      if [[ "$(uname -s)" == Darwin ]]; then echo 'Start Docker Desktop with: open -a Docker'
      else echo 'Start Docker Engine (for a system service: sudo systemctl start docker), or start your Docker context’s engine.'
      fi ;;
    podman)
      if [[ "$(uname -s)" == Darwin ]]; then echo 'Start its VM with: podman machine start'
      else echo 'Check the selected Podman connection with: podman info (local Linux Podman needs no daemon).'
      fi ;;
    *) echo "Check the selected runtime with: $1 info" ;;
  esac
}

detect_container_runtime() {
  local candidate installed=""
  if [[ -n "${CONTAINER_RUNTIME:-}" ]]; then
    if ! command -v "$CONTAINER_RUNTIME" >/dev/null 2>&1; then
      echo "Selected runtime '$CONTAINER_RUNTIME' is not installed or not on PATH." >&2
      return 1
    fi
    if ! runtime_ready "$CONTAINER_RUNTIME"; then
      echo "Selected runtime '$CONTAINER_RUNTIME' is not responding (readiness checks allow 5 seconds)." >&2
      runtime_start_instruction "$CONTAINER_RUNTIME" >&2
      return 1
    fi
    printf '%s\n' "$CONTAINER_RUNTIME"
    return
  fi
  for candidate in container docker podman; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if runtime_ready "$candidate"; then printf '%s\n' "$candidate"; return; fi
      installed="$installed $candidate"
    fi
  done
  if [[ -n "$installed" ]]; then
    echo "No container runtime is responding. Installed:$installed" >&2
    for candidate in $installed; do runtime_start_instruction "$candidate" >&2; done
  else
    echo 'Install Apple container, Docker or Podman, or set CONTAINER_RUNTIME to its executable.' >&2
  fi
  return 1
}
