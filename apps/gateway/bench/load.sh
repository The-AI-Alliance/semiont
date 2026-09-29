#!/bin/sh
# load.sh <label>=<gateway binary>... — each gateway under the same load, one
# after another, on Alpine as the image is. From the repository root:
#
#   container run --rm -c 12 -m 8g -v "$PWD":/work -w /work alpine:3.24 \
#     sh apps/gateway/bench/load.sh now=apps/gateway/target/release/semiont-gateway
#
# The gateway gets CPUs 0-7 (so eight workers) and wrk the next four, so the
# two never share a core. Each scenario runs once to warm up and then RUNS
# times; the table reports the median run's requests per second and latency,
# and the gateway's peak resident memory across all of them. Any answer that is
# not a 2xx fails the run: a benchmark of refusals measures nothing.
#
# Then what a stream costs: streams.mjs opens STREAMS streams at once, each
# read and each with its own clientId, and the second table reports the
# gateway's resident memory before and with them open, and the cost per stream.
#
#   health   GET /api/health: the accept loop and the router, nothing else
#   emit     POST /bus/emit, an empty beckon:focus: a token checked, a body read
#            and validated, a frame published
#   emit-8k  the same with an 8 KiB mark:added payload
set -eu

GATEWAY_CPUS=0-7
WRK_CPUS=8-11
WRK_THREADS=4
CONNECTIONS=256
DURATION=10s
WARMUP=3s
RUNS=3
STREAMS="1000 10000"
PORT=4000
DOMAIN=bench.example

[ "$#" -gt 0 ] || { echo "usage: load.sh <label>=<gateway binary>..." >&2; exit 2; }
[ "$(nproc)" -ge 12 ] || { echo "load.sh needs 12 CPUs (the gateway's eight and wrk's four); this container has $(nproc)" >&2; exit 2; }
apk add --no-cache wrk openssl util-linux-misc nodejs >/dev/null 2>&1
BENCH=$(dirname "$0")

WORK=$(mktemp -d)
trap 'kill "$GATEWAY" 2>/dev/null || true; rm -rf "$WORK"' EXIT
GATEWAY=

JWT_SECRET=$(openssl rand -hex 32)
cat > "$WORK/gateway.json" <<DOC
{"kb":{"name":"Load","domain":"$DOMAIN"},"port":$PORT,"publicUrl":"http://127.0.0.1:$PORT",
 "identity":{"issuer":"http://127.0.0.1:1","subjectClaim":"sub"},"archivist":{"host":"127.0.0.1","port":1},
 "signal":{"type":"in-process"},"logLevel":"warn","logFormat":"json",
 "capacity":{"queuedBytes":1073741824,"connections":52428}}
DOC

# An agent token the gateway signed, as far as it can tell: HS256 under its key.
# It holds semiont-worker, whose coefficients are unlimited (x-semiont-limits),
# so the benchmark measures the gateway rather than a principal's bucket.
b64url() { base64 | tr -d '\n=' | tr '/+' '_-'; }
now=$(date +%s)
header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
claims=$(printf '{"did":"did:web:%s:agents:bench:load","email":"load@agents.%s","name":"bench load","domain":"%s","iat":%s,"exp":%s,"iss":"%s","roles":["semiont-worker"]}' \
  "$DOMAIN" "$DOMAIN" "$DOMAIN" "$now" "$((now + 36000))" "$DOMAIN" | b64url)
signature=$(printf '%s.%s' "$header" "$claims" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)
TOKEN="$header.$claims.$signature"

emit_script() { # <file> <body>
  cat > "$1" <<LUA
wrk.method = "POST"
wrk.headers["Content-Type"] = "application/json"
wrk.headers["Authorization"] = "Bearer $TOKEN"
wrk.body = '$2'
LUA
}
emit_script "$WORK/emit.lua" '{"channel":"beckon:focus","payload":{}}'
emit_script "$WORK/emit-8k.lua" "{\"channel\":\"mark:added\",\"payload\":{\"filler\":\"$(head -c 8192 /dev/zero | tr '\0' x)\"}}"
printf 'wrk.method = "GET"\n' > "$WORK/health.lua"

target() { # <scenario> → its URL
  case "$1" in
    health) echo "http://127.0.0.1:$PORT/api/health" ;;
    *) echo "http://127.0.0.1:$PORT/bus/emit" ;;
  esac
}

# <scenario> <duration> → "rps p50 p99" of one run, milliseconds
run() {
  out=$(taskset -c "$WRK_CPUS" wrk -t"$WRK_THREADS" -c"$CONNECTIONS" -d"$2" --latency -s "$WORK/$1.lua" "$(target "$1")")
  if echo "$out" | grep -q 'Non-2xx'; then
    echo "$1: the gateway refused requests — $(echo "$out" | grep 'Non-2xx')" >&2
    exit 1
  fi
  ms() { awk -v v="$1" 'BEGIN { if (v ~ /us$/) printf "%.3f", v / 1000; else if (v ~ /ms$/) printf "%.3f", v + 0; else printf "%.3f", v * 1000 }'; }
  rps=$(echo "$out" | awk '/^Requests\/sec:/ { print $2 }')
  p50=$(echo "$out" | awk '$1 == "50%" { print $2 }')
  p99=$(echo "$out" | awk '$1 == "99%" { print $2 }')
  echo "$rps $(ms "$p50") $(ms "$p99")"
}

rss_kib() { awk '/^VmRSS:/ { print $2 }' "/proc/$GATEWAY/status"; }

printf '%-12s %-8s %12s %9s %9s %10s\n' binary scenario 'req/s' 'p50 ms' 'p99 ms' 'peak RSS'
STREAM_LINES=""
for pair in "$@"; do
  label=${pair%%=*}
  binary=${pair#*=}
  SEMIONT_GATEWAY_CONFIG="$WORK/gateway.json" JWT_SECRET="$JWT_SECRET" SEMIONT_OIDC_CLIENT_ID=load SEMIONT_OIDC_CLIENT_SECRET=load \
    taskset -c "$GATEWAY_CPUS" "$binary" >"$WORK/$label.log" 2>&1 &
  GATEWAY=$!
  tries=0
  until wget -q -O /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -le 200 ] || { cat "$WORK/$label.log" >&2; exit 1; }
    sleep 0.05
  done
  lines=""
  for scenario in health emit emit-8k; do
    run "$scenario" "$WARMUP" >/dev/null
    runs=""
    i=0
    while [ "$i" -lt "$RUNS" ]; do
      runs="$runs$(run "$scenario" "$DURATION")
"
      i=$((i + 1))
    done
    median=$(printf '%s' "$runs" | sort -n | awk -v n="$RUNS" 'NR == int((n + 1) / 2)')
    lines="$lines$scenario $median
"
  done
  peak=$(awk '/^VmHWM:/ { printf "%.0f MiB", $2 / 1024 }' "/proc/$GATEWAY/status")
  for streams in $STREAMS; do
    before=$(rss_kib)
    taskset -c "$WRK_CPUS" node "$BENCH/streams.mjs" "http://127.0.0.1:$PORT" "$TOKEN" "$streams" >"$WORK/streams.out" 2>&1 &
    holder=$!
    until grep -q '^open' "$WORK/streams.out"; do sleep 0.2; done
    grep -q 'failed 0$' "$WORK/streams.out" || { echo "streams: $(cat "$WORK/streams.out")" >&2; exit 1; }
    sleep 3
    with=$(rss_kib)
    kill "$holder"
    wait "$holder" 2>/dev/null || true
    sleep 3
    STREAM_LINES="$STREAM_LINES$label $streams $before $with
"
  done
  kill "$GATEWAY"
  wait "$GATEWAY" 2>/dev/null || true
  GATEWAY=
  printf '%s' "$lines" | while read -r scenario rps p50 p99; do
    printf '%-12s %-8s %12.0f %9s %9s %10s\n' "$label" "$scenario" "$rps" "$p50" "$p99" "$peak"
  done
done

printf '\n%-12s %8s %12s %12s %14s\n' binary streams 'RSS before' 'RSS with' 'per stream'
printf '%s' "$STREAM_LINES" | while read -r label streams before with; do
  printf '%-12s %8s %9s MiB %9s MiB %10s KiB\n' "$label" "$streams" "$((before / 1024))" "$((with / 1024))" "$(( (with - before) / streams ))"
done
