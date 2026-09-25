package launcher

// observed.go — what `semiont status` can say about work in flight, read from
// surfaces the running stack already publishes.
//
// Two sources, neither of them new:
//
//   - the COLLECTOR's Prometheus readout on :24110. It runs on every start,
//     observed or not (--no-observe declines the backends — Jaeger and
//     Prometheus — never the collector's own pipeline), and status already
//     fetches that exact URL as the collector's health probe. Reading the body
//     it was discarding costs one parse.
//   - the DISPATCHER's health body, which has always carried the job-queue
//     driver it connected to and has always been thrown away by a probe that
//     only looks at the status code.
//
// Both are host-side, unauthenticated, and already inside the report's
// existing time budget. Nothing here adds an endpoint or a round trip.

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// forEachSample walks one metric's samples in a Prometheus text readout —
// those named `name` whose labels carry every pair in `want` — and hands each
// value to visit. Stops early when visit returns false.
//
// Requiring labels also settles the prefix collision a readout is full of:
// for `semiont_job_queue_size_estimate` the remainder after the name opens
// with "_", not "{", so it is skipped rather than read as the metric asked for.
func forEachSample(readout, name string, want map[string]string, visit func(v float64) bool) {
	for _, line := range strings.Split(readout, "\n") {
		if !strings.HasPrefix(line, name) {
			continue
		}
		rest := line[len(name):]
		if !strings.HasPrefix(rest, "{") {
			continue
		}
		end := strings.LastIndex(rest, "}")
		if end < 0 {
			continue
		}
		labels := rest[1:end]
		matched := true
		for k, v := range want {
			if !strings.Contains(labels, k+`="`+v+`"`) {
				matched = false
				break
			}
		}
		if !matched {
			continue
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(rest[end+1:]), 64)
		if err != nil {
			continue
		}
		if !visit(f) {
			return
		}
	}
}

// promGaugeInt reads one gauge sample. Reports false when the series is
// absent — which is never the same fact as a zero reading, and no caller may
// render it as one. A service that has not exported yet (the interval is 30s)
// and a service reporting zero look identical only if someone substitutes a
// value here, so nothing is substituted.
func promGaugeInt(readout, name string, want map[string]string) (int, bool) {
	value, found := 0.0, false
	forEachSample(readout, name, want, func(v float64) bool {
		value, found = v, true
		return false
	})
	return int(value), found
}

// promSumInt adds every matching sample rather than taking the first.
// Counters arrive split across the labels they are recorded with — job
// outcomes by `job_type`, and one series per process reporting them — so a
// total is a sum over all of them, and a reader that took the first would
// silently report one job type's work as the whole.
func promSumInt(readout, name string, want map[string]string) (int, bool) {
	total, found := 0.0, false
	forEachSample(readout, name, want, func(v float64) bool {
		total += v
		found = true
		return true
	})
	return int(total), found
}

// jobsConcluded: how many jobs have actually finished, from the monotonic
// outcome counter rather than the queue's own five counts.
//
// The queue's terminal counts describe its STORE, which now forgets a job a
// day after it concludes — useful, but a rolling window rather than a total.
// This counter is only ever added to, so it answers the different question:
// how much work has been done.
//
// Two honest limits, both of which the rendering names rather than hides.
// It counts what a WORKER concluded, and `recordJobOutcome` is called with
// `completed` or `failed` only — a cancelled job never reaches it, so this is
// work attempted, not every job that left the queue. And a counter lives with
// its process: it starts at zero when the worker does, which is why the line
// says since when rather than implying all time.
func jobsConcluded(readout string) (completed, failed int, ok bool) {
	const c = "semiont_job_outcome_total"
	comp, cok := promSumInt(readout, c, map[string]string{"job_outcome": "completed"})
	fail, fok := promSumInt(readout, c, map[string]string{"job_outcome": "failed"})
	// Either may legitimately be absent — nothing has failed yet on most
	// stacks — so the pair reports present when either does, with the missing
	// one a true zero rather than an unknown.
	return comp, fail, cok || fok
}

// queueDepth: what the dispatcher is working on right now.
//
// PENDING AND RUNNING ONLY, and that is a correctness choice rather than
// brevity. The same gauge carries complete/failed/cancelled, and those three
// answer a different question: not what the dispatcher is working on, but
// what it recently finished. Both queue drivers now drop a job's record a day
// after it concludes, so the counts are a rolling window rather than the
// lifetime totals they were — bounded, but still throughput and not depth.
// Printed beside a live depth they would read as one snapshot and silently be
// a mixture of two questions; if throughput is worth showing it earns its own
// line, with the window named.
func queueDepth(readout string) (pending, running int, ok bool) {
	const g = "semiont_job_queue_size"
	svc := map[string]string{"job": "semiont-dispatcher"}
	with := func(status string) map[string]string {
		m := map[string]string{"job_status": status}
		for k, v := range svc {
			m[k] = v
		}
		return m
	}
	p, pok := promGaugeInt(readout, g, with("pending"))
	r, rok := promGaugeInt(readout, g, with("running"))
	return p, r, pok && rok
}

// ledgerOccupancy: the gateway's correlation ledger — live claims, against the
// ceiling they are measured against. Retained replies are not reported: they
// live in the broker's KV table, bounded by its TTL, not in the gateway.
//
// The ceilings are READ, not restated. They belong to the gateway
// (signal/options.ts) and ride the same gauge as extra series precisely so
// this file does not carry a second copy of a number that can change without
// it. A count with no ceiling cannot answer the question worth asking, which
// is whether the ledger is idle or one request from refusing.
//
// Per gateway process: every replica projects the same shared claims table, so
// the gauge is that table as the exporting process holds it — the same on every
// replica, give or take the watch's lag. On a local stack there is one gateway.
func ledgerOccupancy(readout string) (claims, claimsMax int, ok bool) {
	const g = "semiont_bus_correlation_size"
	// The collector renders OTel's dotted attribute keys with underscores, so
	// `correlation.kind` arrives as `correlation_kind` (as `job.status` does).
	get := func(k string) (int, bool) {
		return promGaugeInt(readout, g, map[string]string{"job": "semiont-gateway", "correlation_kind": k})
	}
	c, cok := get("claims")
	cm, cmok := get("claims_max")
	return c, cm, cok && cmok
}

// printInFlight renders one role's in-flight line beneath its status row, or
// nothing at all.
//
// An absent series prints NOTHING rather than zeros. The gap between a
// service's boot and its first metric export is 30 seconds wide, and "queue 0
// pending" during it would be a confident lie about a dispatcher that has not
// spoken yet. Silence is the honest rendering of a number nobody has reported.
func printInFlight(u *UI, role, readout string) {
	switch role {
	case "dispatcher":
		if pending, running, ok := queueDepth(readout); ok {
			line := fmt.Sprintf("%d pending · %d running", pending, running)
			// The counter is the worker's, so it is absent on a stack whose
			// worker has never run one — and absent stays unsaid.
			if completed, failed, done := jobsConcluded(readout); done {
				line += fmt.Sprintf(" · %d completed · %d failed since worker start",
					completed, failed)
			}
			fmt.Printf("      %-10s %s\n", "queue", u.Dim(line))
		}
	case "gateway":
		if claims, claimsMax, ok := ledgerOccupancy(readout); ok {
			fmt.Printf("      %-10s %s\n", "ledger", u.Dim(fmt.Sprintf("%d/%d claims", claims, claimsMax)))
		}
	}
}

// queueDriverDisplay names the job-queue driver the dispatcher reports.
// Unknown values pass through verbatim, exactly as driverDisplay does for a
// role's driver: a driver this launcher has not heard of must show its own
// name rather than be dropped or, worse, labelled as something else.
//
// "JetStream" rather than "NATS JetStream": `dispatcher (JetStream)` is
// exactly the 22 columns the SERVICE cell allows, and the broker is already
// named one section down on the messaging row.
func queueDriverDisplay(driver string) string {
	switch driver {
	case "jetstream":
		return "JetStream"
	case "fs":
		return "files"
	}
	return driver
}

// dispatcherQueueDriver: the driver the dispatcher actually connected to, from
// its own health body — the live fact, not the configured intent. A stack
// whose config says jetstream but whose dispatcher fell back would otherwise
// report the config's wish.
func dispatcherQueueDriver(endpoint string) (string, bool) {
	body, ok := httpBody(endpoint)
	if !ok {
		return "", false
	}
	var h struct {
		Queue string `json:"queue"`
	}
	if err := json.Unmarshal([]byte(body), &h); err != nil || h.Queue == "" {
		return "", false
	}
	return queueDriverDisplay(h.Queue), true
}
