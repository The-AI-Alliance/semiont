#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
OPERATION="${1:?Supply generate[-GROUP] or check-generated[-GROUP]}"
CHECK=false
case "$OPERATION" in
  generate) GROUP="" ;;
  check-generated) GROUP=""; CHECK=true ;;
  generate-*) GROUP=${OPERATION#generate-} ;;
  check-generated-*) GROUP=${OPERATION#check-generated-}; CHECK=true ;;
  *) echo "Unknown generation operation: $OPERATION" >&2; exit 2 ;;
esac
if [[ -n "$GROUP" ]] && ! grep -Fxq "$GROUP" packages/codegen/groups.txt; then
  echo "Unknown generation group: $GROUP" >&2; exit 2
fi
source "$REPO_ROOT/packages/python/scripts/container-tools.sh"
RT=$(detect_container_runtime)
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/semiont/codegen"
mkdir -p "$CACHE_ROOT"
TEMP_DIRS=()
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  for temp in ${TEMP_DIRS[@]+"${TEMP_DIRS[@]}"}; do
    tool_python packages/codegen/operations.py clean "$temp" || true
  done
  stop_python_tools
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
start_python_tools
NODE_IMAGE="node:$(packages/typescript/scripts/node-version.sh)-alpine"
GO_IMAGE="golang:$(packages/go/scripts/go-toolchain.sh)"
PYTHON_IMAGE="python:$(packages/python/scripts/python-floor.sh)-alpine"
INSTALLED=false BUNDLED=false DONE=""
SUFFIX=""
[[ "$CHECK" == true ]] && SUFFIX=:check
run() { local image="$1"; shift; "$RT" run --rm -m 8g -v "$REPO_ROOT":/workspace -w /workspace "$image" "$@"; }
npm_script() { run "$NODE_IMAGE" npm run "$1"; }
install() {
  if [[ "$INSTALLED" != true ]]; then run "$NODE_IMAGE" npm ci --include=optional --ignore-scripts; INSTALLED=true; fi
}
bundle() {
  if [[ "$BUNDLED" != true ]]; then install; npm_script openapi:bundle; BUNDLED=true; fi
}
go_generate() {
  local source="$1" temp="" argument
  local command=() mounts=()
  if [[ "$CHECK" == true ]]; then
    temp=$(mktemp -d "$CACHE_ROOT/codegen-go.XXXXXX")
    TEMP_DIRS+=("$temp")
    mounts=(-v "$temp:/generated")
  fi
  while IFS= read -r -d '' argument; do command+=("$argument"); done < <(tool_python packages/codegen/operations.py go "$source" "$CHECK")
  [[ ${#command[@]} -gt 0 ]] || { echo "Cannot read the generator command in $source" >&2; return 1; }
  "$RT" run --rm -m 8g -v "$REPO_ROOT":/workspace ${mounts[@]+"${mounts[@]}"} -w /workspace "$GO_IMAGE" go run "${command[@]}"
  if [[ "$CHECK" == true ]]; then tool_python packages/codegen/operations.py compare-go "$source" "$temp/output.go"; fi
}
typescript() {
  install
  if [[ "$CHECK" != true ]]; then run "$NODE_IMAGE" npm run prebuild --workspace=@semiont/core; return; fi
  local temp
  temp=$(git ls-files -z -- packages/typescript/core | tool_python --stdin packages/codegen/operations.py snapshot "$CACHE_ROOT")
  TEMP_DIRS+=("$temp")
  "$RT" run --rm -m 8g -v "$temp:/workspace" -v "$REPO_ROOT/node_modules:/workspace/node_modules" -w /workspace \
    "$NODE_IMAGE" npm run prebuild --workspace=@semiont/core
  tool_python packages/codegen/operations.py compare-typescript "$temp"
}
group() {
  local name="$1"
  [[ " $DONE " == *" $name "* ]] && return
  DONE="$DONE $name"
  case "$name" in
    typescript) group bus; typescript ;;
    python)
      npm_script "generate:python$SUFFIX"
      bundle
      local flag=""
      [[ "$CHECK" == true ]] && flag=--check
      run "$PYTHON_IMAGE" sh -c "pip install --quiet uv && UV_PROJECT_ENVIRONMENT=/venv uv run --project packages/python/sdk --locked python packages/python/sdk/scripts/generate_models.py $flag"
      ;;
    go)
      group bus
      npm_script "generate:go$SUFFIX"
      bundle
      go_generate packages/go/sdk/api/generate.go
      run "$NODE_IMAGE" node packages/go/sdk/scripts/check-go-schema-coverage.mjs
      ;;
    discovery-go) go_generate packages/go/launcher/discovery.go ;;
    encoding-cases|model-catalogue) install; npm_script "generate:$name$SUFFIX" ;;
    *) npm_script "generate:$name$SUFFIX" ;;
  esac
}
if [[ -n "$GROUP" ]]; then group "$GROUP"
else while IFS= read -r name; do group "$name"; done < packages/codegen/groups.txt
fi
