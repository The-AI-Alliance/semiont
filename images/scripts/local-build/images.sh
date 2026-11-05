#!/usr/bin/env bash
# Sourced by the local build session.

if [[ "$PACKAGES_ONLY" != true ]]; then

# --- Build container images ---
#
# Same production Dockerfiles as the publish workflows, tagged
# ghcr.io/the-ai-alliance/semiont-<svc>:local. The Node image, the Browser's,
# installs from the local Verdaccio; the gateway, the dispatcher, the
# archivist, the worker, the smelter, the weaver and the librarian are built
# from the working tree. The
# :local tag is what `semiont start` runs where a KB's stack documents name it
# (it pulls no image tagged :local), and it is never pushed.
#
# For a Node image --no-cache is required for correctness, not caution: iterating republishes
# the SAME version to Verdaccio, so the `npm install` RUN line is byte-identical
# and a cached layer would silently reuse the stale packages.

banner "CONTAINER IMAGES"

# --- Image fan-out targets ---
#
# The :local images land in $RT's image store, invisible to every other
# engine — a KB started with a different --runtime then fails with
# "semiont-<svc>:local: not found". Build once under $RT, then load each
# built image into every OTHER responsive runtime. A fan-out failure is a
# warning, not a build failure (the primary store is intact).
#
# File-based transfer only: `container image save` cannot stream (`-o -`
# writes a literal file named "-"; /dev/stdout truncates the archive), so
# pipe-less save→load via a temp file is the portable shape.
# An installed-but-unresponsive engine (e.g. Docker Desktop not running)
# warns once here and is skipped; an absent engine is silently ignored.
FANOUT_RTS=""
for rt in container docker podman; do
  [[ "$FANOUT" == true ]] || break
  [[ "$rt" == "$RT" ]] && continue
  command -v "$rt" >/dev/null 2>&1 || continue
  if "$rt" image list >/dev/null 2>&1; then
    FANOUT_RTS="$FANOUT_RTS $rt"
  else
    warn "$rt is installed but not responding — :local images will NOT be visible to it (start it and re-load manually: $RT image save <tag> -o /tmp/img.tar && $rt image load -i /tmp/img.tar)"
  fi
done
FANOUT_FAILURES=""
[[ -n "$FANOUT_RTS" ]] && step "Fan-out: images will also be loaded into${BOLD}$FANOUT_RTS${RESET}"


# Copies every :local image into each OTHER responsive runtime. Loops runtime
# OUTSIDE image so the happy path is one line per destination rather than one
# per image — a per-image ✓ says the same thing seven times. Failures stay
# per-image, because that is when you need to know WHICH.
#
# `image save` prints the tag it wrote; without the redirect that echo lands
# between the log lines and reads like stray output.
fanout_all() {
  local rt tmp tag img n
  for rt in $FANOUT_RTS; do
    n=0
    for img in $IMAGES; do
      tag="ghcr.io/the-ai-alliance/semiont-${img}:local"
      tmp=$(mktemp "$TMP_DIR/semiont-fanout.XXXXXX")
      if $RT image save "$tag" -o "$tmp" >/dev/null 2>&1 && "$rt" image load -i "$tmp" >/dev/null 2>&1; then
        n=$((n + 1))
      else
        warn "Fan-out of $tag to $rt failed (build unaffected; manual: $RT image save $tag -o /tmp/img.tar && $rt image load -i /tmp/img.tar)"
        FANOUT_FAILURES="$FANOUT_FAILURES $rt:$tag"
      fi
      rm -f "$tmp"
    done
    if [ "$n" -gt 0 ]; then
      ok "$n image(s) → $rt image store"
    fi
  done
}

source "$BUILD_DIR/image-plan.sh"
BUILD_IMGS=()
BUILD_SIGS=()
for img in $IMAGES; do
  decide_image "$img"
  if [[ "$IMAGE_ACTION" == skip ]]; then
    summarize "images/$img" "$IMAGE_REASON"
  else
    BUILD_IMGS+=("$img")
    BUILD_SIGS+=("$IMAGE_SIGNATURE")
  fi
done
# --- The image each build replaces ---
#
# :local is a mutable tag: a rebuilt image takes it from the one before, which
# stays in the store with nothing naming it, so every run would add a layer set
# to every store it reaches. Before a build, the image the tag names is tagged
# :local-previous, in the building engine and in each one the images are loaded
# into, and that tag is deleted once the new image is built, keeps its promises
# and is loaded everywhere. The engine then reclaims what no tag and no
# container names, and refuses (a warning here) an image a container still
# uses. A run that fails keeps the old image under both tags, and the next run
# replaces the second.
keep_previous() {  # <runtime> <image>
  local tag="ghcr.io/the-ai-alliance/semiont-$2:local"
  if "$1" image inspect "$tag" >/dev/null 2>&1; then
    "$1" image tag "$tag" "$tag-previous" >/dev/null 2>&1 || warn "could not keep $tag in $1 as $tag-previous"
  fi
}
drop_previous() {  # <runtime> <image>
  local previous="ghcr.io/the-ai-alliance/semiont-$2:local-previous"
  "$1" image inspect "$previous" >/dev/null 2>&1 || return 0
  "$1" image rm "$previous" >/dev/null 2>&1 \
    || warn "$1 keeps the image $previous replaced (a container uses it, or the engine refused: $1 image rm $previous)"
}
for img in ${BUILD_IMGS[@]+"${BUILD_IMGS[@]}"}; do
  for rt in $RT $FANOUT_RTS; do keep_previous "$rt" "$img"; done
done

if [[ ${#BUILD_IMGS[@]} -eq 0 ]]; then
  ok "All images unchanged — nothing to build"
else
  # The per-build log path is ~90 characters of noise on a "Building" line on
  # the happy path; a failure tails its own log, and this glob is how you
  # watch one live.
  step "Building ${#BUILD_IMGS[@]} image(s), 3 at a time ${DIM}(logs: $TMP_DIR/semiont-build-*)${RESET}"
  # `container build` creates the singleton `buildkit` builder LAZILY, so three
  # builds launched together race to create it and two die with "container
  # already exists: buildkit". It only bites when the builder is absent — i.e.
  # straight after a prune, which is exactly when a full rebuild is run.
  # Create it once, serially, before the batch.
  if [[ "$RT" == "container" ]] && ! $RT ls -a 2>/dev/null | grep -qE "^buildkit[[:space:]]"; then
    step "Starting the buildkit builder ${DIM}(absent — parallel builds would race to create it)${RESET}"
    $RT builder start >/dev/null 2>&1 || warn "could not pre-start the buildkit builder — builds may race"
  fi
fi

# --layer-cache: the Rust images' layers come from, and go back to, a directory
# a CI runner keeps between runs. docker's default builder exports no cache
# but the inline kind, so a docker-container builder does the three builds,
# and --load puts each image in docker's store where the stack boots it. All
# three read the cache; none writes it. The write is one more build of the
# gateway's Dockerfile after the batch and the Rust images' timed checks,
# wholly from the builder's own cache, that outputs nothing but the layers:
# nothing builds while those checks time a start. The three share one builder stage,
# which lint:rust-images holds to the same text and BuildKit compiles once.
# The new cache is written beside the old and swapped in, so the directory
# holds one run's layers and does not grow.
if [[ -n "$LAYER_CACHE" ]]; then
  if [[ "$RT" != "docker" ]]; then
    fail "--layer-cache needs docker (the engine is $RT)"
    exit 1
  fi
  if ! docker buildx inspect semiont-layer-cache >/dev/null 2>&1; then
    step "Creating the docker-container builder that reads and writes the layer cache"
    docker buildx create --name semiont-layer-cache --driver docker-container >/dev/null
  fi
fi
# Up to three builds at a time, and the next one starts as soon as any
# finishes: ~30s of EVERY build is fixed buildkit-shim latency (10s
# "transferring" round-trips for byte-sized payloads), which overlapping
# absorbs, and the npm and Python images build while the Rust one compiles. Three, not
# six: the builder VM has 2G. The one heavy build is the Rust builder stage,
# which the gateway, dispatcher and archivist images share, so it compiles once
# however they overlap. Build output goes to a per-image log; a failure tails it and
# stops the run.
# Fan-out happens after all builds, keeping the builder VM to itself.
PIDS=(); TAGS=(); LOGS=(); IMGS=(); STARTS=(); NAMES=(); DONE=(); TIMED=()
next=0
running=0
# Stop the builds still running rather than leaving them to grind against
# whatever broke; their logs stay on disk.
stop_builds() {
  local k
  for k in "${!PIDS[@]}"; do
    [ "${DONE[$k]}" -eq 0 ] && kill "${PIDS[$k]}" 2>/dev/null || true
  done
}
# image_promises <name> <tag>: what the built image of <name> promises. The
# Rust images carry no source and start (or refuse) quickly, and a Python
# service's image carries every library it can be configured for and refuses
# by name, and the smelter's reads a scanned page with no network, or they are
# not built.
image_promises() {
  case "$1" in
    gateway)              "$REPO_ROOT/images/scripts/check-gateway-image.sh" "$2" "$RT" ;;
    dispatcher|archivist) "$REPO_ROOT/images/scripts/check-document-image.sh" "$1" "$2" "$RT" ;;
    worker|smelter|weaver|librarian) "$REPO_ROOT/images/scripts/check-python-image.sh" "$1" "$2" "$RT" ;;
    *)                    true ;;
  esac
}
# image_kept <index>: a build whose image keeps its promises is recorded as
# built, so an unchanged image is not built again.
image_kept() {
  local idx=${IMGS[$1]}
  if [[ -n "${BUILD_SIGS[$idx]}" ]]; then
    state_put "images/${BUILD_IMGS[$idx]}" "${BUILD_SIGS[$idx]}"
  fi
  summarize "images/${BUILD_IMGS[$idx]}" "built"
}
# A cold npm install inside these builds runs for MINUTES with nothing on
# stdout, and --no-cache means every run pays it. That silence reads as a
# hang. Name what is still in flight every 30s so a
# slow build is distinguishable from a stopped one without going to `ps`.
beat=$(date +%s)
while [ $next -lt ${#BUILD_IMGS[@]} ] || [ $running -gt 0 ]; do
  while [ $running -lt 3 ] && [ $next -lt ${#BUILD_IMGS[@]} ]; do
    img=${BUILD_IMGS[$next]}
    DF=$(image_dockerfile "$img")
    TAG="ghcr.io/the-ai-alliance/semiont-${img}:local"
    LOG=$(mktemp "$TMP_DIR/semiont-build-${img}.XXXXXX")
    step "Building ${TAG} from ${DF}..."
    # The gateway, the dispatcher and the archivist compile from the repository
    # with the pinned toolchain, and the worker, the smelter, the weaver and the
    # librarian are installed from it on the Python floor, with what their
    # lockfiles pin. Their
    # layers are keyed by what they copy, so a cached one is never stale.
    # The Browser's image installs from Verdaccio, where --no-cache is what keeps
    # a republished same-version package from being reused stale (above).
    BUILD_CMD=("$RT" build)
    case "$img" in
      gateway|dispatcher|archivist)
        BUILD_FLAGS=(--build-arg "RUST_TOOLCHAIN=$RUST_TOOLCHAIN")
        if [[ -n "$LAYER_CACHE" ]]; then
          BUILD_CMD=(docker buildx build --builder semiont-layer-cache --load)
          [[ -d "$LAYER_CACHE" ]] && BUILD_FLAGS+=(--cache-from "type=local,src=$LAYER_CACHE")
        fi ;;
      worker|smelter|weaver|librarian) BUILD_FLAGS=(--build-arg "PYTHON_FLOOR=$PYTHON_FLOOR") ;;
      *)                            BUILD_FLAGS=(--no-cache --build-arg "NPM_REGISTRY=$BUILD_REGISTRY") ;;
    esac
    "${BUILD_CMD[@]}" "${BUILD_FLAGS[@]}" --tag "$TAG" \
      --file "$REPO_ROOT/$DF" \
      "$REPO_ROOT" > "$LOG" 2>&1 &
    PIDS+=($!)
    TAGS+=("$TAG")
    NAMES+=("$img")
    LOGS+=("$LOG")
    IMGS+=("$next")
    STARTS+=("$(date +%s)")
    DONE+=(0)
    running=$((running + 1))
    next=$((next + 1))
  done
  # Reap in COMPLETION order, not start order. Waiting on the first build
  # first means a hung build hides the others: two builds fail in seconds
  # against a dead registry, a third hangs on npm's retry backoff, and the run
  # looks stuck for minutes with the real errors already on disk.
  # bash 3.2 has no `wait -n`, so poll with kill -0 and reap whoever finishes.
  for j in "${!PIDS[@]}"; do
    [ "${DONE[$j]}" -eq 1 ] && continue
    kill -0 "${PIDS[$j]}" 2>/dev/null && continue
    DONE[$j]=1
    running=$((running - 1))
    st=0
    wait "${PIDS[$j]}" || st=$?
    if [ "$st" -ne 0 ]; then
      fail "${TAGS[$j]} build failed (exit $st) — last 40 lines of ${LOGS[$j]}:"
      tail -40 "${LOGS[$j]}"
      stop_builds
      exit 1
    fi
    ok "${TAGS[$j]} built ${DIM}($(( $(date +%s) - ${STARTS[$j]} ))s)${RESET}"
    beat=$(date +%s)
    rm -f "${LOGS[$j]}"
    # The Rust images' checks time a start on this machine: they wait for the
    # batch (below).
    case "${NAMES[$j]}" in
      gateway|dispatcher|archivist)
        TIMED+=("$j")
        continue ;;
    esac
    if ! image_promises "${NAMES[$j]}" "${TAGS[$j]}"; then
      fail "${TAGS[$j]} does not keep the ${NAMES[$j]} image's promises (above)"
      stop_builds
      exit 1
    fi
    image_kept "$j"
  done
  if [ "$running" -gt 0 ]; then
    now=$(date +%s)
    if [ $((now - beat)) -ge 30 ]; then
      inflight=""
      for k in "${!PIDS[@]}"; do
        if [ "${DONE[$k]}" -eq 0 ]; then
          inflight="$inflight ${NAMES[$k]} ($((now - ${STARTS[$k]}))s)"
        fi
      done
      echo -e "${DIM}  still building:${inflight}${RESET}"
      beat=$now
    fi
    sleep 1
  fi
done

# The Rust images' checks bound how soon each starts, or refuses, timed on
# this machine (START_BOUND_MS in check-gateway-image.sh), so they run once
# nothing else builds. A gateway image from the layer cache is built in
# seconds; checked then, beside the Python images still building, its 100 ms
# start measured 330 ms.
for j in ${TIMED[@]+"${TIMED[@]}"}; do
  if ! image_promises "${NAMES[$j]}" "${TAGS[$j]}"; then
    fail "${TAGS[$j]} does not keep the ${NAMES[$j]} image's promises (above)"
    exit 1
  fi
  image_kept "$j"
done

# This run's layers are written now, after the batch and its checks, and
# replace the last run's: see --layer-cache above.
if [[ -n "$LAYER_CACHE" ]]; then
  step "Writing the Rust images' layers for the next run"
  EXPORT_FLAGS=(--build-arg "RUST_TOOLCHAIN=$RUST_TOOLCHAIN")
  [[ -d "$LAYER_CACHE" ]] && EXPORT_FLAGS+=(--cache-from "type=local,src=$LAYER_CACHE")
  LOG=$(mktemp "$TMP_DIR/semiont-layer-cache.XXXXXX")
  if ! docker buildx build --builder semiont-layer-cache "${EXPORT_FLAGS[@]}" \
      --cache-to "type=local,dest=$LAYER_CACHE.next,mode=max" --output type=cacheonly \
      --file "$REPO_ROOT/images/gateway/Dockerfile" "$REPO_ROOT" > "$LOG" 2>&1; then
    fail "writing the layer cache failed — last 40 lines of $LOG:"
    tail -40 "$LOG"
    exit 1
  fi
  rm -f "$LOG"
  rm -rf "$LAYER_CACHE"
  mv "$LAYER_CACHE.next" "$LAYER_CACHE"
  ok "The Rust images' layers are kept in $LAYER_CACHE for the next run"
fi

# Fan-out covers skipped images too: it heals the case where another runtime
# was down when the image was last built.
fanout_all

for img in ${BUILD_IMGS[@]+"${BUILD_IMGS[@]}"}; do
  for rt in $RT $FANOUT_RTS; do drop_previous "$rt" "$img"; done
done

# --- Image-store accounting ---
#
# What each store holds after the run. The image a build replaced is deleted
# above; what is left is every image the store holds, this script's and
# others'. Neither engine volunteers the number, so it is reported here.
# Reporting only; a failure here must never fail a build that already
# succeeded.
store_report() {
  local rt="$1" line=""
  case "$rt" in
    docker|podman)
      # The engine's own accounting, including what a prune would reclaim.
      line=$("$rt" system df 2>/dev/null | awk '/^Images/{print $4" in "$2" images, "$5" reclaimable"}') || line=""
      ;;
    container)
      # Apple container has no `system df`; sum the per-image sizes it reports
      # as human strings ("56.3 MB"). Decimal units, as the engine prints them.
      line=$(container image list --format json 2>/dev/null | tool_python --stdin -c '
import sys, json
units = {"B": 1, "KB": 1e3, "kB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}
try:
    imgs = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
total = 0.0
for i in imgs:
    p = str(i.get("fullSize", "")).split()
    if len(p) == 2 and p[1] in units:
        try:
            total += float(p[0]) * units[p[1]]
        except ValueError:
            pass
print(f"{total/1e9:.1f}GB in {len(imgs)} images")
' 2>/dev/null) || line=""
      ;;
  esac
  [[ -z "$line" ]] && return 0
  echo -e "  ${BOLD}${rt}${RESET}: ${line}"
  echo -e "      ${DIM}prune unused: ${rt} image prune -a${RESET}"
}

echo ""
step "Image stores after fan-out"
for rt in $RT $FANOUT_RTS; do
  store_report "$rt"
done

if [[ "$IMAGES_ONLY" == true ]]; then
  # Deliberately stops here. The drift gates and the launcher are unrelated to
  # image contents, and paying for them would undo the point of the flag — a
  # one-image rebuild should cost about a minute.
  banner "IMAGES DONE ✓"
  print_summary
  echo -e "  Restart the affected service(s) to pick them up, e.g."
  echo -e "    ${BOLD}semiont restart${RESET}  (in a KB whose .semiont/stack documents name the :local images)"
  echo ""
  echo -e "${DIM}Skipped (use a full run for these): the packages, the drift and lockfile gates, the launcher.${RESET}"
  echo ""
  echo -e "\033[2m[$(date '+%Y-%m-%d %H:%M:%S')] local-build finished (--images-only)\033[0m"
  SESSION_SUCCEEDED=true
  exit 0
fi


fi
