package launcher

import (
	"strings"
	"testing"
)

// The two knowledge bases sampleReadout holds, by their DIDs. A DID may hold
// punctuation (`%`, `,`, `=`) and is read as it is.
const (
	kbA = "did:web:example.github.io:test-kb"
	kbB = "did:web:example.github.io%3A8443:a,b=c"
)

// A slice of the collector's readout (localhost:24110) where two knowledge
// bases' services export, shortened by dropping unrelated metrics. The label
// sets, their spelling and their order are the collector's — 0.137.0's, as
// collectorConfig renders it, which carries each resource attribute as a label
// (`semiont.kb` as `semiont_kb`, `service.name` as `service_name`) and sorts a
// series' labels by name. The job outcome counter's are its row of
// specs/src/service-telemetry/telemetry.json (`job.type`, and `job.motivation`
// on a mark job only), with `semiont_kb` on each point.
const sampleReadout = `# HELP semiont_job_queue_size Job queue size by status
# TYPE semiont_job_queue_size gauge
semiont_job_queue_size{job="semiont-dispatcher",job_status="cancelled",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io%3A8443:a,b=c",service_name="semiont-dispatcher",service_version="0.6.13"} 0
semiont_job_queue_size{job="semiont-dispatcher",job_status="cancelled",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io:test-kb",service_name="semiont-dispatcher",service_version="0.6.13"} 5
semiont_job_queue_size{job="semiont-dispatcher",job_status="complete",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io%3A8443:a,b=c",service_name="semiont-dispatcher",service_version="0.6.13"} 40
semiont_job_queue_size{job="semiont-dispatcher",job_status="complete",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io:test-kb",service_name="semiont-dispatcher",service_version="0.6.13"} 133
semiont_job_queue_size{job="semiont-dispatcher",job_status="failed",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io%3A8443:a,b=c",service_name="semiont-dispatcher",service_version="0.6.13"} 0
semiont_job_queue_size{job="semiont-dispatcher",job_status="failed",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io:test-kb",service_name="semiont-dispatcher",service_version="0.6.13"} 1
semiont_job_queue_size{job="semiont-dispatcher",job_status="pending",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io%3A8443:a,b=c",service_name="semiont-dispatcher",service_version="0.6.13"} 9
semiont_job_queue_size{job="semiont-dispatcher",job_status="pending",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io:test-kb",service_name="semiont-dispatcher",service_version="0.6.13"} 3
semiont_job_queue_size{job="semiont-dispatcher",job_status="running",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io%3A8443:a,b=c",service_name="semiont-dispatcher",service_version="0.6.13"} 1
semiont_job_queue_size{job="semiont-dispatcher",job_status="running",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io:test-kb",service_name="semiont-dispatcher",service_version="0.6.13"} 2
# HELP semiont_bus_correlation_size Correlation registry occupancy
# TYPE semiont_bus_correlation_size gauge
semiont_bus_correlation_size{correlation_kind="claims",job="semiont-gateway",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io%3A8443:a,b=c",service_name="semiont-gateway",service_version="0.6.13"} 1
semiont_bus_correlation_size{correlation_kind="claims",job="semiont-gateway",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io:test-kb",service_name="semiont-gateway",service_version="0.6.13"} 7
semiont_bus_correlation_size{correlation_kind="claims_max",job="semiont-gateway",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io%3A8443:a,b=c",service_name="semiont-gateway",service_version="0.6.13"} 512
semiont_bus_correlation_size{correlation_kind="claims_max",job="semiont-gateway",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io:test-kb",service_name="semiont-gateway",service_version="0.6.13"} 4096
# HELP semiont_job_outcome_total Job outcomes
# TYPE semiont_job_outcome_total counter
semiont_job_outcome_total{job="semiont-worker",job_outcome="completed",job_type="yield",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io%3A8443:a,b=c",service_name="semiont-worker",service_version="0.6.13"} 6
semiont_job_outcome_total{job="semiont-worker",job_outcome="completed",job_type="yield",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io:test-kb",service_name="semiont-worker",service_version="0.6.13"} 4
semiont_job_outcome_total{job="semiont-worker",job_motivation="highlighting",job_outcome="completed",job_type="mark",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io:test-kb",service_name="semiont-worker",service_version="0.6.13"} 5
semiont_job_outcome_total{job="semiont-worker",job_motivation="tagging",job_outcome="completed",job_type="mark",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io:test-kb",service_name="semiont-worker",service_version="0.6.13"} 1
semiont_job_outcome_total{job="semiont-worker",job_outcome="failed",job_type="yield",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io%3A8443:a,b=c",service_name="semiont-worker",service_version="0.6.13"} 1
semiont_job_outcome_total{job="semiont-worker",job_outcome="failed",job_type="yield",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io:test-kb",service_name="semiont-worker",service_version="0.6.13"} 2
semiont_job_outcome_total{job="semiont-worker",job_motivation="linking",job_outcome="failed",job_type="mark",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:example.github.io:test-kb",service_name="semiont-worker",service_version="0.6.13"} 1
`

// Each knowledge base's readings are its own numbers, never the other's
// beside or instead of them; and a knowledge base the readout does not hold —
// one whose DID merely begins another's among them — reads nothing.
func TestEachKnowledgeBaseReadsItsOwnNumbers(t *testing.T) {
	type numbers struct{ pending, running, claims, claimsMax, completed, failed int }
	for _, c := range []struct {
		kb   string
		want numbers
	}{
		{kbA, numbers{pending: 3, running: 2, claims: 7, claimsMax: 4096, completed: 10, failed: 3}},
		{kbB, numbers{pending: 9, running: 1, claims: 1, claimsMax: 512, completed: 6, failed: 1}},
	} {
		var got numbers
		var queued, ledgered, concluded bool
		got.pending, got.running, queued = queueDepth(sampleReadout, c.kb)
		got.claims, got.claimsMax, ledgered = ledgerOccupancy(sampleReadout, c.kb)
		got.completed, got.failed, concluded = jobsConcluded(sampleReadout, c.kb)
		if !queued || !ledgered || !concluded {
			t.Errorf("%s: series present in the readout but not found (queue %v, ledger %v, outcomes %v)", c.kb, queued, ledgered, concluded)
		}
		if got != c.want {
			t.Errorf("%s: read %+v, want %+v", c.kb, got, c.want)
		}
	}
	for _, other := range []string{"did:web:example.github.io:other-kb", "did:web:example.github.io:test"} {
		if _, _, ok := queueDepth(sampleReadout, other); ok {
			t.Errorf("queueDepth read a dispatcher for %s, which the readout does not hold", other)
		}
		if _, _, ok := ledgerOccupancy(sampleReadout, other); ok {
			t.Errorf("ledgerOccupancy read a gateway for %s, which the readout does not hold", other)
		}
		if _, _, ok := jobsConcluded(sampleReadout, other); ok {
			t.Errorf("jobsConcluded read a worker's outcomes for %s, which the readout does not hold", other)
		}
	}
}

// What status prints beneath a running dispatcher and gateway is the
// knowledge base's own numbers. For a knowledge base the readout does not
// hold it prints nothing. Where the worker's outcomes name no knowledge base,
// the queue is printed without them.
func TestStatusPrintsEachKnowledgeBasesOwnNumbers(t *testing.T) {
	var queueOnly strings.Builder
	for _, line := range strings.SplitAfter(sampleReadout, "\n") {
		if !strings.HasPrefix(line, "semiont_job_outcome_total{") {
			queueOnly.WriteString(line)
		}
	}
	const other = "did:web:example.github.io:other-kb"
	u := &UI{}
	for _, c := range []struct {
		role, readout, kb, want string
	}{
		{"dispatcher", sampleReadout, kbA, "      queue      3 pending · 2 running · 10 completed · 3 failed since worker start\n"},
		{"dispatcher", sampleReadout, kbB, "      queue      9 pending · 1 running · 6 completed · 1 failed since worker start\n"},
		{"dispatcher", queueOnly.String(), kbA, "      queue      3 pending · 2 running\n"},
		{"gateway", sampleReadout, kbA, "      ledger     7/4096 claims\n"},
		{"gateway", sampleReadout, kbB, "      ledger     1/512 claims\n"},
		{"dispatcher", sampleReadout, other, ""},
		{"gateway", sampleReadout, other, ""},
	} {
		got, _ := captureOutput(t, func() { printInFlight(u, c.role, c.readout, c.kb) })
		if got != c.want {
			t.Errorf("%s of %s: printed %q, want %q", c.role, c.kb, got, c.want)
		}
	}
}

// A series that names no knowledge base is no knowledge base's: a readout
// whose collector does not carry the resource as labels reads as nothing at
// all, not as this one's.
func TestASeriesThatNamesNoKnowledgeBaseIsNotRead(t *testing.T) {
	const unlabelled = `semiont_job_queue_size{job="semiont-dispatcher",job_status="pending",otel_scope_name="semiont"} 3
semiont_job_queue_size{job="semiont-dispatcher",job_status="running",otel_scope_name="semiont"} 2
semiont_bus_correlation_size{correlation_kind="claims",job="semiont-gateway",otel_scope_name="semiont"} 7
semiont_bus_correlation_size{correlation_kind="claims_max",job="semiont-gateway",otel_scope_name="semiont"} 4096
semiont_job_outcome_total{job="semiont-worker",job_outcome="completed",job_type="yield",otel_scope_name="semiont"} 4
`
	if _, _, ok := queueDepth(unlabelled, kbA); ok {
		t.Error("queueDepth read a dispatcher that names no knowledge base")
	}
	if _, _, ok := ledgerOccupancy(unlabelled, kbA); ok {
		t.Error("ledgerOccupancy read a gateway that names no knowledge base")
	}
	if _, _, ok := jobsConcluded(unlabelled, kbA); ok {
		t.Error("jobsConcluded read a worker's outcomes that name no knowledge base")
	}
}

// The readout escapes a label's `"` and `\`, and a DID may hold either: the
// reading asks for the DID as the readout writes it.
func TestADIDIsReadAsTheReadoutEscapesIt(t *testing.T) {
	const readout = `semiont_bus_correlation_size{correlation_kind="claims",job="semiont-gateway",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:quote\"back\\slash",service_name="semiont-gateway",service_version="0.6.13"} 7
semiont_bus_correlation_size{correlation_kind="claims_max",job="semiont-gateway",otel_scope_name="semiont",otel_scope_schema_url="",otel_scope_version="",semiont_kb="did:web:quote\"back\\slash",service_name="semiont-gateway",service_version="0.6.13"} 4096
`
	claims, claimsMax, ok := ledgerOccupancy(readout, `did:web:quote"back\slash`)
	if !ok || claims != 7 || claimsMax != 4096 {
		t.Errorf("got %d/%d claims (ok=%v), want 7/4096", claims, claimsMax, ok)
	}
}

// The distinction the rendering depends on: a service that has not exported
// yet must be unreportable, not reported as idle. If this ever returns ok for
// a readout with no dispatcher in it, `semiont status` starts claiming an
// empty queue for a dispatcher that has said nothing.
func TestAbsentSeriesIsNotZero(t *testing.T) {
	const noDispatcher = `semiont_job_queue_size{job="semiont-worker",job_status="pending",semiont_kb="did:web:example.github.io:test-kb"} 4
semiont_bus_correlation_size{correlation_kind="claims",job="semiont-gateway",semiont_kb="did:web:example.github.io:test-kb"} 1
`
	if _, _, ok := queueDepth(noDispatcher, kbA); ok {
		t.Error("queueDepth reported a reading for a dispatcher that never exported")
	}
	// The gateway is present but its ceilings are not: a partial series must
	// not render as a count against a ceiling of zero.
	if _, _, ok := ledgerOccupancy(noDispatcher, kbA); ok {
		t.Error("ledgerOccupancy reported a reading without its ceilings")
	}
	if _, _, ok := queueDepth("", kbA); ok {
		t.Error("queueDepth reported a reading from an empty readout")
	}
}

// A metric whose name merely begins with the one being asked for must not be
// mistaken for it — Prometheus readouts are full of `_total`/`_bucket` kin.
func TestPromGaugeDoesNotMatchALongerName(t *testing.T) {
	const readout = `semiont_job_queue_size_estimate{job="semiont-dispatcher",job_status="pending",semiont_kb="did:web:example.github.io:test-kb"} 99
semiont_job_queue_size{job="semiont-dispatcher",job_status="pending",semiont_kb="did:web:example.github.io:test-kb"} 3
`
	v, ok := promGaugeInt(readout, "semiont_job_queue_size", kbA,
		map[string]string{"job": "semiont-dispatcher", "job_status": "pending"})
	if !ok || v != 3 {
		t.Errorf("got %d (ok=%v), want 3 — the longer metric name was matched", v, ok)
	}
}

// The SERVICE cell is %-22s wide; a longer product name shoves every column
// after it out of alignment for the whole report.
func TestQueueDriverDisplayFitsTheServiceColumn(t *testing.T) {
	if n := len("dispatcher (" + queueDriverDisplay("jetstream") + ")"); n > 22 {
		t.Errorf("dispatcher (%s) is %d columns, want <= 22", queueDriverDisplay("jetstream"), n)
	}
}

func TestQueueDriverDisplayPassesUnknownDriversThrough(t *testing.T) {
	for driver, want := range map[string]string{
		"jetstream": "JetStream",
		// A driver this launcher predates must name itself rather than vanish.
		"sqs": "sqs",
	} {
		if got := queueDriverDisplay(driver); got != want {
			t.Errorf("queueDriverDisplay(%q) = %q, want %q", driver, got, want)
		}
	}
}

// The counter arrives split by job type, by a mark job's motivation and by
// reporting process, so a total is a sum. Taking the first sample would report
// one job type's work as all of it — 4 instead of 10 — and nothing about the
// number would look wrong.
func TestJobsConcludedSumsAcrossJobTypesAndMotivations(t *testing.T) {
	completed, failed, ok := jobsConcluded(sampleReadout, kbA)
	if !ok {
		t.Fatal("outcome counter present in the readout but not found")
	}
	if completed != 10 || failed != 3 {
		t.Errorf("completed/failed = %d/%d, want 10/3 (summed across job types and motivations)", completed, failed)
	}
}

// Nothing has failed on most stacks, and that is a real zero rather than an
// unknown — the figure must still render.
func TestJobsConcludedReportsWhenOnlyOneOutcomeExists(t *testing.T) {
	const onlyCompleted = `semiont_job_outcome_total{job="semiont-worker",job_outcome="completed",job_type="yield",semiont_kb="did:web:example.github.io:test-kb"} 3
`
	completed, failed, ok := jobsConcluded(onlyCompleted, kbA)
	if !ok || completed != 3 || failed != 0 {
		t.Errorf("got %d completed, %d failed (ok=%v); want 3/0", completed, failed, ok)
	}
	// A worker that has concluded nothing has no counter at all.
	if _, _, ok := jobsConcluded("", kbA); ok {
		t.Error("reported concluded jobs from an empty readout")
	}
}
