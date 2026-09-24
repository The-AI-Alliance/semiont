package launcher

import "testing"

// A verbatim slice of a real collector readout (localhost:24110, a running
// stack). Hand-shortened only by dropping unrelated metrics — the label sets,
// their spelling and their order are the collector's, not this test's.
const sampleReadout = `# HELP semiont_job_queue_size Job queue size by status
# TYPE semiont_job_queue_size gauge
semiont_job_queue_size{job="semiont-dispatcher",job_status="cancelled",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version=""} 5
semiont_job_queue_size{job="semiont-dispatcher",job_status="complete",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version=""} 133
semiont_job_queue_size{job="semiont-dispatcher",job_status="failed",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version=""} 1
semiont_job_queue_size{job="semiont-dispatcher",job_status="pending",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version=""} 3
semiont_job_queue_size{job="semiont-dispatcher",job_status="running",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version=""} 2
# HELP semiont_bus_correlation_size Correlation registry occupancy
# TYPE semiont_bus_correlation_size gauge
semiont_bus_correlation_size{correlation_kind="claims",job="semiont-gateway",otel_scope_name="semiont"} 7
semiont_bus_correlation_size{correlation_kind="claims_max",job="semiont-gateway",otel_scope_name="semiont"} 4096
semiont_bus_correlation_size{correlation_kind="retained_replies",job="semiont-gateway",otel_scope_name="semiont"} 2
semiont_bus_correlation_size{correlation_kind="retained_replies_max",job="semiont-gateway",otel_scope_name="semiont"} 1024
`

func TestQueueDepthReadsTheDispatchersLiveCounts(t *testing.T) {
	pending, running, ok := queueDepth(sampleReadout)
	if !ok {
		t.Fatal("dispatcher series present in the readout but not found")
	}
	if pending != 3 || running != 2 {
		t.Errorf("pending/running = %d/%d, want 3/2", pending, running)
	}
}

func TestLedgerOccupancyReadsCountsAndCeilings(t *testing.T) {
	claims, claimsMax, retained, retainedMax, ok := ledgerOccupancy(sampleReadout)
	if !ok {
		t.Fatal("gateway ledger series present in the readout but not found")
	}
	if claims != 7 || claimsMax != 4096 || retained != 2 || retainedMax != 1024 {
		t.Errorf("occupancy = %d/%d claims, %d/%d retained; want 7/4096, 2/1024",
			claims, claimsMax, retained, retainedMax)
	}
}

// The distinction the rendering depends on: a service that has not exported
// yet must be unreportable, not reported as idle. If this ever returns ok for
// a readout with no dispatcher in it, `semiont status` starts claiming an
// empty queue for a dispatcher that has said nothing.
func TestAbsentSeriesIsNotZero(t *testing.T) {
	const noDispatcher = `semiont_job_queue_size{job="semiont-worker",job_status="pending"} 4
semiont_bus_correlation_size{correlation_kind="claims",job="semiont-gateway"} 1
`
	if _, _, ok := queueDepth(noDispatcher); ok {
		t.Error("queueDepth reported a reading for a dispatcher that never exported")
	}
	// The gateway is present but its ceilings are not: a partial series must
	// not render as a count against a ceiling of zero.
	if _, _, _, _, ok := ledgerOccupancy(noDispatcher); ok {
		t.Error("ledgerOccupancy reported a reading without its ceilings")
	}
	if _, _, ok := queueDepth(""); ok {
		t.Error("queueDepth reported a reading from an empty readout")
	}
}

// A metric whose name merely begins with the one being asked for must not be
// mistaken for it — Prometheus readouts are full of `_total`/`_bucket` kin.
func TestPromGaugeDoesNotMatchALongerName(t *testing.T) {
	const readout = `semiont_job_queue_size_estimate{job="semiont-dispatcher",job_status="pending"} 99
semiont_job_queue_size{job="semiont-dispatcher",job_status="pending"} 3
`
	v, ok := promGaugeInt(readout, "semiont_job_queue_size",
		map[string]string{"job": "semiont-dispatcher", "job_status": "pending"})
	if !ok || v != 3 {
		t.Errorf("got %d (ok=%v), want 3 — the longer metric name was matched", v, ok)
	}
}

// The SERVICE cell is %-22s wide; a longer product name shoves every column
// after it out of alignment for the whole report.
func TestQueueDriverDisplayFitsTheServiceColumn(t *testing.T) {
	for _, driver := range []string{"jetstream", "fs"} {
		if n := len("dispatcher (" + queueDriverDisplay(driver) + ")"); n > 22 {
			t.Errorf("dispatcher (%s) is %d columns, want <= 22", queueDriverDisplay(driver), n)
		}
	}
}

func TestQueueDriverDisplayPassesUnknownDriversThrough(t *testing.T) {
	for driver, want := range map[string]string{
		"jetstream": "JetStream",
		"fs":        "files",
		// A driver this launcher predates must name itself rather than vanish.
		"sqs": "sqs",
	} {
		if got := queueDriverDisplay(driver); got != want {
			t.Errorf("queueDriverDisplay(%q) = %q, want %q", driver, got, want)
		}
	}
}
