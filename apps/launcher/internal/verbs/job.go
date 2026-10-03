package verbs

// job.go — the job lifecycle a delegated verb follows. `yield --delegate` and
// `mark --delegate` are not one request and its reply: each creates a job
// (job:create → job:created names it) and then follows job:report-progress,
// job:complete and job:fail, which are BROADCASTS correlated by jobId — not by
// the correlationId the bus client uses elsewhere. The subscription therefore
// opens BEFORE the job is created: the jobId is unknown at that moment, so
// events are buffered and filtered once it arrives. Subscribing after would
// race a fast job.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// delegatedJob: one job a verb creates and follows to its end.
type delegatedJob struct {
	verb string // names the verb in a refusal: "mark --delegate"
	// doing and note narrate the start: "Annotating res-1 (highlighting; job
	// job-1)". note may be empty.
	doing, note string
	failed      string // what failed, in "Annotation failed: …"
	check       string // the command that shows what a job still running has done
	create      semiont.JobCreateCommand
}

// run creates the job and follows it. It returns the job:complete the job
// ended with, read and as it arrived. ok=false: the job failed, or could not
// be created or followed, and that was said.
func (j delegatedJob) run(u *launcher.UI, cli bus.Transport) (done semiont.JobCompleteCommand, raw json.RawMessage, ok bool) {
	ctx := context.Background()
	sub, err := cli.Subscribe(ctx, []bus.Channel{"job:report-progress", "job:complete", "job:fail"}, nil, "")
	if err != nil {
		busFail(u, j.verb, err)
		return done, nil, false
	}
	defer sub.Close()

	created, err := cli.Request(ctx, "job:create", j.create, nil)
	if err != nil {
		busFail(u, j.verb, err)
		return done, nil, false
	}
	var jc semiont.JobCreatedResult
	if json.Unmarshal(created, &jc) != nil || jc.Response.JobId == "" {
		u.Fail("%s: the gateway accepted the job but named no jobId.", j.verb)
		return done, nil, false
	}
	jobID := jc.Response.JobId
	note := "job " + jobID
	if j.note != "" {
		note = j.note + "; " + note
	}
	u.Log("%s %s", j.doing, u.Dim("("+note+")"))

	// A job can run for minutes; narrate it rather than leaving a silent
	// terminal. Each job channel carries its own command schema, so each is
	// read with its own generated type. These are broadcasts, and every
	// viewer of the KB sees them: another job's are skipped.
	for {
		ev, open := <-sub.Events
		if !open {
			u.Fail("The event stream closed before job %s finished.", jobID)
			fmt.Fprintln(os.Stderr, "  The job may still be running:  "+j.check)
			return done, nil, false
		}
		switch ev.Channel {
		case "job:report-progress":
			var p semiont.JobReportProgressCommand
			if json.Unmarshal(ev.Payload, &p) != nil || p.JobId != jobID || p.Progress == nil {
				continue
			}
			// JobProgress is the one progress shape for every job type. The
			// wire carries a code and typed params, never a sentence: each
			// client owns its own words. A code this launcher does not know
			// prints nothing rather than an empty bullet.
			if text := progressText(p.Progress.Message); text != "" {
				u.Log("%s", u.Dim(text))
			}
		case "job:fail":
			var f semiont.JobFailCommand
			if json.Unmarshal(ev.Payload, &f) != nil || f.JobId != jobID {
				continue
			}
			// A failure the queue will retry is an event of a job still
			// running: a fresh attempt continues it, and stopping here would
			// report a recovering run as a failed one. Absent reads as
			// terminal, the safe direction: a command that ends early is
			// seen, one that never ends is not.
			if f.WillRetry != nil && *f.WillRetry {
				attempt := "An attempt"
				if f.Attempt != nil {
					attempt = fmt.Sprintf("Attempt %d", *f.Attempt)
				}
				u.Log("%s", u.Dim(fmt.Sprintf("%s failed (%s); the queue is running the job again", attempt, f.Error)))
				continue
			}
			u.Fail("%s failed: %s", j.failed, f.Error)
			return done, nil, false
		case "job:complete":
			if json.Unmarshal(ev.Payload, &done) != nil || done.JobId != jobID {
				continue
			}
			return done, ev.Payload, true
		}
	}
}

// jobResult: the member of the JobResult union a completed job reported, as
// its own type; nil when the job reported none, or one this launcher does not
// know.
//
// The result says what it is by its `kind`, and that is read first.
// oapi-codegen's As*() accessors are bare json.Unmarshal calls with no
// discriminant test, so every member "decodes" successfully against every
// other member's payload: AsJobGenerationResult on a decline returns a
// zero-valued struct with a nil error. A caller that tried them in turn would
// report a decline as a resource with no id.
func jobResult(done semiont.JobCompleteCommand) any {
	if done.Result == nil {
		return nil
	}
	result, err := done.Result.ValueByDiscriminator()
	if err != nil {
		return nil
	}
	return result
}

// declineText renders a decline reason as English terminal copy — the sibling
// of progressText below, and for the same reason: the wire carries a CODE, and
// each client owns its words. react-ui translates these five reasons into 29
// locales; a terminal is English-only by design, which is exactly why the
// gateway must not compose the sentence for both.
//
// An unrecognized reason falls back to the raw code rather than an empty
// string: for a CLI a bare token is still diagnostic, and a decline the user
// cannot name is worse than an ugly one.
func declineText(reason semiont.JobDeclinedResultReason) string {
	switch reason {
	case "no-text-layer":
		return "this PDF is a scan whose text could not be recognized, so there was nothing to annotate"
	case "encrypted":
		return "this PDF is password-protected, so its text could not be read"
	case "corrupt":
		return "this PDF could not be read — the file may be damaged"
	case "too-large":
		return "this document is too large to extract text from"
	case "empty":
		return "this document has no text to annotate"
	}
	return string(reason)
}

// progressText renders a JobProgressMessage code as English terminal copy.
// The wire deliberately carries no sentence — every client owns its words
// (react-ui translates into 29 locales; this terminal is English-only by
// design). Decodes the union through its raw JSON into one flat shape
// rather than the generated As*() accessors, which unmarshal with no
// discriminant check (jobResult above has that lesson). An unknown or absent
// code renders "", and the caller prints nothing for it: a new code degrades
// legibly instead of breaking an old launcher.
func progressText(m *semiont.JobProgressMessage) string {
	if m == nil {
		return ""
	}
	raw, err := m.MarshalJSON()
	if err != nil {
		return ""
	}
	var flat struct {
		Code       string `json:"code"`
		EntityType string `json:"entityType"`
		Count      int    `json:"count"`
		Kind       string `json:"kind"`
	}
	if json.Unmarshal(raw, &flat) != nil {
		return ""
	}
	switch flat.Code {
	case "loading":
		return "Loading resource"
	case "analyzing":
		return "Analyzing text"
	case "analyzing-tags":
		return "Analyzing text for tags"
	case "generating-resource":
		return "Generating resource"
	case "creating-resource":
		return "Creating resource"
	case "complete-generated":
		return "Created resource"
	case "detecting-entities":
		return fmt.Sprintf("Detecting %s entities", flat.EntityType)
	case "creating-annotations":
		return fmt.Sprintf("Creating %d annotations", flat.Count)
	case "creating-tag-annotations":
		return fmt.Sprintf("Creating %d tag annotations", flat.Count)
	case "complete-created":
		return fmt.Sprintf("Created %d %ss", flat.Count, flat.Kind)
	default:
		return ""
	}
}
