#!/usr/bin/env bash
# Sourced by the local build session.

# --- The registry, for the images that install from one ---

if [[ -n "$REGISTRY_IMAGES" || "$OPERATION" == npm-publish-local ]]; then

banner "LOCAL REGISTRY"

if [[ "$IMAGES_ONLY" == true ]]; then
  # Reuse the registry a previous run left up. VERDACCIO_OURS stays false, so
  # the cleanup trap will not tear down a registry we did not create.
  step "Reusing the running Verdaccio (make images-only)..."
  if ! curl -sf "$REGISTRY/-/ping" > /dev/null 2>&1; then
    fail "No Verdaccio at $REGISTRY — make images-only builds against the registry a previous run left running."
    echo ""
    echo -e "  Run a full build first:  ${BOLD}make local-build${RESET}"
    echo ""
    exit 1
  fi
  REUSED_COUNT=$(curl -sf "$REGISTRY/-/verdaccio/data/packages" 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)
  if [[ "${REUSED_COUNT:-0}" -eq 0 ]]; then
    fail "Verdaccio at $REGISTRY is up but holds no packages — an image build would have nothing to install."
    echo ""
    echo -e "  Run a full build first:  ${BOLD}make local-build${RESET}"
    echo ""
    exit 1
  fi
  ok "Verdaccio reachable with $REUSED_COUNT packages (reused, not rebuilt)"
else
  # Replace only the named registry from an earlier local-build session.
  $RT stop "$VERDACCIO_NAME" >/dev/null 2>&1 || true
  $RT rm "$VERDACCIO_NAME" >/dev/null 2>&1 || true
  if python3 -c 'import socket,sys
try:
    socket.create_connection(("localhost", 4873), timeout=0.3).close()
except OSError:
    sys.exit(1)' ; then
    fail "Port 4873 is occupied; stop its owner before starting local Verdaccio."
    exit 1
  fi
  ok "Port 4873 is free"

  VERDACCIO_STORAGE=$(mktemp -d "$CACHE_ROOT/verdaccio-storage.XXXXXX")
  # Copy config into a temp dir so we can mount the whole directory.
  # Apple Container CLI sandboxes single-file bind mounts in a way that
  # makes them unreadable inside the container; a directory mount works.
  VERDACCIO_CONF=$(mktemp -d "$CACHE_ROOT/verdaccio-conf.XXXXXX")
  cp "$SCRIPT_DIR/scripts/verdaccio.yaml" "$VERDACCIO_CONF/config.yaml"
  # The verdaccio image runs as its own user (uid 10001), and mktemp makes both
  # dirs 0700 for the user running this script. Where a runtime enforces
  # ownership on bind mounts — docker and podman on Linux — the registry can
  # then neither read its config nor write its storage ("config file does not
  # exist or not reachable"). Apple container's shares do not enforce it.
  chmod 0755 "$VERDACCIO_CONF"
  chmod 0777 "$VERDACCIO_STORAGE"

  # Note: intentionally no --rm — Apple Container CLI v0.11 silently drops
  # detached containers that use --rm, making logs unreachable on failure.
  # The EXIT trap above handles cleanup instead.
  # --memory is EXPLICIT for the same reason the launcher sets it on every
  # service: the silent default is the worst value. Apple container gives 1G,
  # and three concurrent image builds pulling tarballs through this registry
  # while it proxies large packages from upstream kill it there: builds die
  # with ECONNRESET, and verdaccio's log just stops mid-fetch with no shutdown
  # line.
  $RT run -d \
    --name "$VERDACCIO_NAME" \
    --memory 4G \
    -p 4873:4873 \
    -v "$VERDACCIO_CONF:/verdaccio/conf" \
    -v "$VERDACCIO_STORAGE:/verdaccio/storage" \
    verdaccio/verdaccio > /dev/null
  VERDACCIO_OURS=true

  # Wait for Verdaccio to be ready
  for i in $(seq 1 30); do
    if curl -sf "$REGISTRY/-/ping" > /dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  if ! curl -sf "$REGISTRY/-/ping" > /dev/null 2>&1; then
    fail "Verdaccio failed to start"
    echo "  Container logs:"
    $RT logs "$VERDACCIO_NAME" 2>&1 | tail -20
    exit 1
  fi
  ok "Verdaccio running at $REGISTRY"

  # Verify storage is empty (htpasswd should not exist)

  # Register user and get auth token
  VERDACCIO_TOKEN=""
  for i in $(seq 1 10); do
    RESPONSE=$(curl -s -X PUT "$REGISTRY/-/user/org.couchdb.user:$VERDACCIO_USER" \
      -H 'Content-Type: application/json' \
      -d "{\"name\":\"$VERDACCIO_USER\",\"password\":\"$VERDACCIO_PASS\"}" 2>/dev/null || echo "")
    VERDACCIO_TOKEN=$(echo "$RESPONSE" | grep -o '"token": *"[^"]*"' | cut -d'"' -f4 || echo "")
    if [[ -n "$VERDACCIO_TOKEN" ]]; then
      break
    fi
    sleep 1
  done

  if [[ -z "$VERDACCIO_TOKEN" ]]; then
    fail "Failed to get auth token from fresh Verdaccio (its storage is $VERDACCIO_STORAGE)"
    echo "  Storage dir contents: $(ls -la "$VERDACCIO_STORAGE" 2>/dev/null)"
    echo "  htpasswd: $(cat "$VERDACCIO_STORAGE/htpasswd" 2>/dev/null || echo '(not found)')"
    exit 1
  fi
  ok "Auth token acquired"
fi

# --- Resolve host address ---

HOST_ADDR=$($RT run --rm "$NODE_IMAGE" sh -c "ip route | awk '/default/{print \$3}'")
step "Host address from container: ${DIM}$HOST_ADDR${RESET}"
BUILD_REGISTRY="http://$HOST_ADDR:4873"

fi
