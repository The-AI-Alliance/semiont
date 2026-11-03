#!/usr/bin/env bash
# One disposable Python environment per local operation; never a host Python command.
source "$REPO_ROOT/images/scripts/container-runtime.sh"

start_python_tools() {
  PYTHON_TOOLS_NAME="semiont-python-tools-$$"
  local image
  image="python:$("$REPO_ROOT/packages/python/scripts/python-floor.sh")-alpine"
  local mounts=(-v "$REPO_ROOT:$REPO_ROOT")
  # Planning may read existing state but must not create a host cache directory.
  if [[ -d "$CACHE_ROOT" ]]; then mounts+=(-v "$CACHE_ROOT:$CACHE_ROOT"); fi
  "$RT" run -d --name "$PYTHON_TOOLS_NAME" --memory 512m \
    "${mounts[@]}" -w "$REPO_ROOT" "$image" sleep 86400 >/dev/null
  PYTHON_TOOLS_STARTED=true
  PYTHON_TOOLS_HOST=$("$RT" exec "$PYTHON_TOOLS_NAME" sh -c "ip route | awk '/default/{print \$3}'")
  [[ -n "$PYTHON_TOOLS_HOST" ]] || { echo 'Cannot determine the container host address.' >&2; return 1; }
}

tool_python() {
  if [[ "${1:-}" == --stdin ]]; then
    shift
    "$RT" exec -i "$PYTHON_TOOLS_NAME" python3 "$@"
  else
    "$RT" exec "$PYTHON_TOOLS_NAME" python3 "$@" </dev/null
  fi
}

stop_python_tools() {
  if [[ "${PYTHON_TOOLS_STARTED:-false}" == true ]]; then
    "$RT" stop "$PYTHON_TOOLS_NAME" >/dev/null 2>&1 || true
    "$RT" rm "$PYTHON_TOOLS_NAME" >/dev/null 2>&1 || true
  fi
}
