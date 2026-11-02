#!/usr/bin/env bash
# Sourced by the local build session.

banner "DONE ✓"
print_summary

if [[ "$PACKAGES_ONLY" != true ]]; then
  if [[ -n "$FANOUT_FAILURES" ]]; then
    echo -e "${BOLD}Images tagged :local are in the ${RT} image store${RESET} (fan-out partially failed:${FANOUT_FAILURES// / })"
  elif [[ -n "$FANOUT_RTS" ]]; then
    echo -e "${BOLD}Images tagged :local are in every local image store:${RESET} $RT${FANOUT_RTS}"
  elif [[ "$FANOUT" != true ]]; then
    echo -e "${BOLD}Images tagged :local are in the ${RT} image store${RESET} (FANOUT=0)"
  else
    echo -e "${BOLD}Images tagged :local are in the ${RT} image store${RESET} (no other engines detected)"
  fi
  echo ""

  echo -e "${BOLD}Run the full stack from your KB against these images:${RESET}"
  echo ""
  echo -e "    ${BOLD}cd /path/to/your-kb${RESET}"
  echo -e "    (name the ${DIM}:local${RESET} images in .semiont/stack/*.yaml, e.g. ghcr.io/the-ai-alliance/semiont-gateway:local,"
  echo -e "     and the Browser's and the worker's in their own documents:)"
  echo -e "    ${BOLD}perl -pi -e 's#(semiont-browser):\\S+#\$1:local#' \"\$($REPO_ROOT/apps/launcher/dist/semiont settings browser --path)\"${RESET}"
  echo -e "    ${BOLD}perl -pi -e 's#(semiont-worker):\\S+#\$1:local#' \"\$($REPO_ROOT/apps/launcher/dist/semiont settings worker --path)\"${RESET}"
  echo -e "    ${BOLD}$REPO_ROOT/apps/launcher/dist/semiont start${RESET}"
  echo -e "    ${BOLD}echo password | $REPO_ROOT/apps/launcher/dist/semiont useradd --email admin@example.com${RESET}"
  echo ""
  echo -e "  (semiont start pulls no image tagged ${DIM}:local${RESET}; it runs these.)"
  echo ""

  echo -e "${BOLD}Or run a single image, e.g. the browser:${RESET}"
  echo -e "  $RT run --publish 3000:3000 -it ghcr.io/the-ai-alliance/semiont-browser:local"
  echo ""
fi

PYTHON_SDK_WHEELS=("$REPO_ROOT"/packages/python/sdk/dist/*.whl)
if [[ -e "${PYTHON_SDK_WHEELS[0]}" ]]; then
  echo -e "${BOLD}The Python SDK is built, and published nowhere. Install it by path:${RESET}"
  echo -e "  pip install ${PYTHON_SDK_WHEELS[0]}"
  echo ""
fi

if [[ "$VERDACCIO_OURS" == true ]]; then
  echo -e "${DIM}Stop Verdaccio when done:${RESET}  $RT stop $VERDACCIO_NAME"
  echo ""
fi
echo -e "\033[2m[$(date '+%Y-%m-%d %H:%M:%S')] local-build finished\033[0m"
