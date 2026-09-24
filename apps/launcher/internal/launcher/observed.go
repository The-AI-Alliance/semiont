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

// promGauge finds one sample in a Prometheus text readout: the metric NAME
// carrying every label in want. Reports false when that series is absent —
// which is never the same fact as a zero reading, and no caller may render it
// as one. A service that has not exported yet (the interval is 30s) and a
// service reporting zero look identical only if someone substitutes a value
// here, so nothing is substituted.
func promGauge(readout, name string, want map[string]string) (float64, bool) {
	for _, line := range strings.Split(readout, "\n") {
		if !strings.HasPrefix(line, name) {
			continue
		}
		// Labels are required, which also settles the prefix collision: for
		// `semiont_job_queue_size_extra` the remainder opens with "_", not "{".
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
		return f, true
	}
	return 0, false
}

// promGaugeInt is promGauge for the counts these gauges actually carry.
func promGaugeInt(readout, name string, want map[string]string) (int, bool) {
	f, ok := promGauge(readout, name, want)
	return int(f), ok
}

// queueDepth: what the dispatcher is working on right now.
//
// PENDING AND RUNNING ONLY, and that is a correctness choice rather than
// brevity. The same gauge carries complete/failed/cancelled, but the queue
// deletes no record when a job concludes — the JetStream driver's KV bucket
// keeps every job it has ever seen — so those three are lifetime totals for
// the store. Printed beside a live depth they would read as a snapshot and
// silently be a mixture of two different questions.
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

// ledgerOccupancy: the gateway's correlation ledger — live claims, and how
// many of them still hold a reply payload — each against the ceiling it is
// measured against.
//
// The ceilings are READ, not restated. They belong to the gateway
// (signal/options.ts) and ride the same gauge as extra series precisely so
// this file does not carry a second copy of a number that can change without
// it. A count with no ceiling cannot answer the question worth asking, which
// is whether the ledger is idle or one request from refusing.
//
// Per gateway process: replicas converge on claims through the shared ledger
// address, but the gauge is whatever the exporting process holds. On a local
// stack there is one gateway, so this is the whole truth.
func ledgerOccupancy(readout string) (claims, claimsMax, retained, retainedMax int, ok bool) {
	const g = "semiont_bus_correlation_size"
	// The collector renders OTel's dotted attribute keys with underscores, so
	// `correlation.kind` arrives as `correlation_kind` (as `job.status` does).
	get := func(k string) (int, bool) {
		return promGaugeInt(readout, g, map[string]string{"job": "semiont-gateway", "correlation_kind": k})
	}
	c, cok := get("claims")
	cm, cmok := get("claims_max")
	r, rok := get("retained_replies")
	rm, rmok := get("retained_replies_max")
	return c, cm, r, rm, cok && cmok && rok && rmok
}

// printInFlight renders one role's in-flight line beneath its status row, or
// nothing at all.
//
// An absent series prints NOTHING rather than zeros. The gap between a
// service's boot and its first metric export is 30 seconds wide, and "queue 0
// pending" during it would be a confident lie about a dispatcher that has not
// spoken yet. Silence is the honest rendering of a number nobody has reported.
func printInFlight(u *ui, role, readout string) {
	switch role {
	case "dispatcher":
		if pending, running, ok := queueDepth(readout); ok {
			fmt.Printf("      %-10s %s\n", "queue",
				u.dim(fmt.Sprintf("%d pending · %d running", pending, running)))
		}
	case "gateway":
		if claims, claimsMax, retained, retainedMax, ok := ledgerOccupancy(readout); ok {
			fmt.Printf("      %-10s %s\n", "ledger",
				u.dim(fmt.Sprintf("%d/%d claims · %d/%d retained replies",
					claims, claimsMax, retained, retainedMax)))
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
