#!/usr/bin/env bash
# Shared read-only decision used before image builds and by make plan.
image_signature() {
  tool_python "$SCRIPT_DIR/scripts/image-signature.py" "$REPO_ROOT" \
    "$(image_dockerfile "$1")" "http://$PYTHON_TOOLS_HOST:4873" "$RUST_TOOLCHAIN" "$PYTHON_FLOOR"
}

decide_image() {
  local image="$1" cached
  IMAGE_ACTION=build
  IMAGE_REASON=""
  IMAGE_SIGNATURE=""
  if ! IMAGE_SIGNATURE=$(image_signature "$image"); then
    IMAGE_REASON="missing or unreadable build input"
  fi
  if [[ "$FORCE" == true ]]; then IMAGE_REASON="forced"
  elif [[ "$IMAGES_NAMED" == true ]]; then IMAGE_REASON="explicitly selected"
  elif ! "$RT" image inspect "ghcr.io/the-ai-alliance/semiont-$image:local" >/dev/null 2>&1; then
    IMAGE_REASON="image missing from $RT"
  elif [[ -n "$IMAGE_REASON" ]]; then :
  elif [[ -z "$IMAGE_SIGNATURE" ]]; then IMAGE_REASON="npm dependency integrity unavailable"
  else
    cached=$(state_get "images/$image")
    if [[ -z "$cached" ]]; then IMAGE_REASON="no verified build signature"
    elif [[ "$cached" != "$IMAGE_SIGNATURE" ]]; then IMAGE_REASON="Dockerfile, copied source, toolchain or npm dependencies changed"
    else IMAGE_ACTION=skip; IMAGE_REASON="unchanged inputs and image present in $RT"
    fi
  fi
}
