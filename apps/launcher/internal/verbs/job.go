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
	"math"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"

	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// delegatedJob: one job a verb creates and follows to its end. C is the verb:
// the member of the JobCompleteCommand union its jobType names, which is what
// the job's completion is read as.
type delegatedJob[C any] struct {
	verb string // names the verb in a refusal: "mark --delegate"
	// doing and note narrate the start: "Annotating res-1 (highlighting; job
	// job-1)". note may be empty.
	doing, note string
	failed      string // what failed, in "Annotation failed: …"
	check       string // the command that shows what the job has done
	create      semiont.JobCreateCommand
	jobOf       func(C) semiont.JobId // the job a completion is of
}

// run creates the job and follows it. It returns the job:complete the job
// ended with, read as the verb's and as it arrived. ok=false: the job failed,
// could not be created or followed, or completed as another verb's, and that
// was said.
func (j delegatedJob[C]) run(u *launcher.UI, cli bus.Transport) (done C, raw json.RawMessage, ok bool) {
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
			completed, mine, err := j.completion(jobID, ev.Payload)
			if !mine {
				continue
			}
			if err != nil {
				u.Fail("Job %s %v.", jobID, err)
				fmt.Fprintln(os.Stderr, "  What the job did:  "+j.check)
				return done, nil, false
			}
			return completed, ev.Payload, true
		}
	}
}

// completion reads a job:complete as the completion of the job this verb
// created. mine=false: it is another job's. An error: it is this job's, and
// the union reads it as another verb's or as none: what the job completed as,
// said after its name.
func (j delegatedJob[C]) completion(jobID semiont.JobId, payload json.RawMessage) (done C, mine bool, err error) {
	// Whose job it is: every member of the union names its job, so the
	// payload is read as this verb's to learn that much.
	var read C
	if json.Unmarshal(payload, &read) != nil || j.jobOf(read) != jobID {
		return done, false, nil
	}
	// Whose verb it is: the union's to say, by its discriminator.
	var completed semiont.JobCompleteCommand
	if err := completed.UnmarshalJSON(payload); err != nil {
		return done, true, err
	}
	member, err := completed.ValueByDiscriminator()
	done, isVerbs := member.(C)
	if err != nil || !isVerbs {
		as := "a job that names no type"
		if said, _ := completed.Discriminator(); said != "" {
			as = fmt.Sprintf("a %q job", said)
		}
		return done, true, fmt.Errorf("completed as %s, and %s created a %q job", as, j.verb, j.jobType())
	}
	return done, true, nil
}

// jobType: the verb's job type, as the job:create this verb sends states it.
func (j delegatedJob[C]) jobType() string {
	jobType, _ := j.create.Discriminator()
	return jobType
}

// wireMembers: the members a generated type names, each with whether its
// schema requires it. The generator writes `omitempty` on every member a
// schema leaves optional, and on no other.
func wireMembers(generated reflect.Type) map[string]bool {
	members := map[string]bool{}
	for i := 0; i < generated.NumField(); i++ {
		field := generated.Field(i)
		members[wireName(field)] = !strings.Contains(field.Tag.Get("json"), ",omitempty")
	}
	return members
}

// wireName: the name a generated field is written under.
func wireName(field reflect.StructField) string {
	name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
	return name
}

// sortedNames: a map's keys, in the order a message lists them.
func sortedNames[V any](named map[string]V) []string {
	names := make([]string, 0, len(named))
	for name := range named {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// flagKind: how the value of a job flag is read.
type flagKind int

const (
	flagText     flagKind = iota // --flag <text>
	flagList                     // --flag <text>, repeatable
	flagSet                      // --flag, with no value: true
	flagPositive                 // --flag <n>, a number above 0
)

// jobFlag: the flag that gives one parameter of a delegated job.
type jobFlag struct {
	param string // the parameter's name in the job's schema
	kind  flagKind
}

// jobFlags: the flags that give a delegated verb's job its parameters.
type jobFlags map[string]jobFlag

// take reads the argument a, when it is one of these flags, into given under
// its parameter's name. taken=false: it is not one, and nothing was read.
// ok=false: its value is missing or is not one its kind reads, and that was
// said.
func (flags jobFlags) take(u *launcher.UI, a string, val func() (string, bool), given map[string]any) (taken, ok bool) {
	flag, taken := flags[a]
	if !taken {
		return false, true
	}
	if flag.kind == flagSet {
		given[flag.param] = true
		return true, true
	}
	v, ok := val()
	if !ok {
		return true, false
	}
	switch flag.kind {
	case flagText:
		// An empty text gives nothing: it is how a script leaves an option
		// out, and a parameter the job requires is then one it was not given.
		if v != "" {
			given[flag.param] = v
		}
	case flagList:
		list, _ := given[flag.param].([]string)
		given[flag.param] = append(list, v)
	case flagPositive:
		// 32 bits: the generated types hold a number as a float32.
		n, err := strconv.ParseFloat(v, 32)
		if err != nil || n <= 0 || math.IsInf(n, 0) || math.IsNaN(n) {
			u.Fail("%s wants a number above 0, got %q", a, v)
			return true, false
		}
		given[flag.param] = n
	}
	return true, true
}

// flagOf: the flag that gives a parameter, "" when none does.
func (flags jobFlags) flagOf(param string) string {
	for name, flag := range flags {
		if flag.param == param {
			return name
		}
	}
	return ""
}

// jobParams reads what a verb's flags gave into params, a pointer to the
// generated type of one job's parameters, and refuses what the job's schema
// refuses: a parameter it does not name, a required one that was not given,
// and a value outside an enumeration. Every refusal names the flag. job is how
// the verb names the job in one: "linking", "--delegate".
//
// `minLength` and `minItems` are not read here: the gateway holds every
// job:create to its schema. No flag gives an empty value in any case: an empty
// text gives nothing (take), and a list flag that is given gives an item.
func jobParams(given map[string]any, flags jobFlags, params any, job string) error {
	held := reflect.ValueOf(params).Elem()
	members := wireMembers(held.Type())
	for _, param := range sortedNames(given) {
		if _, named := members[param]; named {
			continue
		}
		var takes []string
		for member := range members {
			if flag := flags.flagOf(member); flag != "" {
				takes = append(takes, flag)
			}
		}
		sort.Strings(takes)
		return fmt.Errorf("%s takes no %s; it takes %s", job, flags.flagOf(param), strings.Join(takes, ", "))
	}
	for _, param := range sortedNames(members) {
		if _, isGiven := given[param]; !members[param] || isGiven {
			continue
		}
		flag := flags.flagOf(param)
		if flag == "" {
			return fmt.Errorf("%s needs the parameter %q, and no flag gives it", job, param)
		}
		return fmt.Errorf("%s needs %s", job, flag)
	}
	written, err := json.Marshal(given)
	if err == nil {
		err = json.Unmarshal(written, params)
	}
	if err != nil {
		return fmt.Errorf("%s: %v", job, err)
	}
	// A generated enumeration says whether a value is one of its own.
	for i := 0; i < held.NumField(); i++ {
		value := held.Field(i)
		if value.Kind() == reflect.Pointer {
			if value.IsNil() {
				continue
			}
			value = value.Elem()
		}
		if enumerated, is := value.Interface().(interface{ Valid() bool }); is && !enumerated.Valid() {
			return fmt.Errorf("%s takes no %s %q", job, flags.flagOf(wireName(held.Type().Field(i))), fmt.Sprint(value.Interface()))
		}
	}
	return nil
}

// resultMember: one member of a verb's result union: its generated type, and
// what the terminal calls it.
type resultMember struct {
	generated any
	called    string
}

// resultMembers: the members of the result union R.
// TestJobResultReadsEveryMemberOfItsVerbsUnion holds each list to its union's
// schema.
type resultMembers[R json.Marshaler] []resultMember

// declinedResult: the member each verb's result union has.
var declinedResult = resultMember{semiont.JobDeclinedResult{}, "a decline"}

// jobResult: what a completed job reported, as the member of its verb's
// result union it is; nil when it reported nothing. An error: what it reported
// is not exactly one of the union's members, said in the terminal's words.
//
// A verb's result union has no discriminant. Its members share no required
// member, so a result is the one member whose required members it carries all
// of. The generated As*() accessors are bare json.Unmarshal calls and cannot
// say: each "decodes" the other's payload, and AsJobGenerationResult on a
// decline returns a zero-valued struct with a nil error.
func jobResult[R json.Marshaler](reported *R, members resultMembers[R]) (any, error) {
	if reported == nil {
		return nil, nil
	}
	raw, err := (*reported).MarshalJSON()
	var carried map[string]json.RawMessage
	if err == nil {
		err = json.Unmarshal(raw, &carried)
	}
	if err != nil {
		return nil, err
	}
	var is []any
	var called []string
	for _, member := range members {
		generated := reflect.TypeOf(member.generated)
		called = append(called, member.called)
		if !carriesRequired(carried, wireMembers(generated)) {
			continue
		}
		read := reflect.New(generated)
		if err := json.Unmarshal(raw, read.Interface()); err != nil {
			return nil, err
		}
		is = append(is, read.Elem().Interface())
	}
	if len(is) != 1 {
		return nil, fmt.Errorf("a result that is neither %s: %s", strings.Join(called, " nor "), raw)
	}
	return is[0], nil
}

// resultFail says that a job completed with a result that is not its verb's,
// and fails the command: a completion nobody can read is not a success.
func (j delegatedJob[C]) resultFail(u *launcher.UI, jobID semiont.JobId, err error) int {
	u.Fail("Job %s completed with %v", jobID, err)
	fmt.Fprintln(os.Stderr, "  What the job did:  "+j.check)
	return 1
}

// carriesRequired: whether an object carries every member a type requires.
func carriesRequired(carried map[string]json.RawMessage, members map[string]bool) bool {
	for name, required := range members {
		if _, has := carried[name]; required && !has {
			return false
		}
	}
	return true
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
// legibly instead of breaking an old launcher. So does what a mark job
// created, of a motivation markNouns has no noun for.
func progressText(m *semiont.JobProgressMessage) string {
	if m == nil {
		return ""
	}
	raw, err := m.MarshalJSON()
	if err != nil {
		return ""
	}
	var flat struct {
		Code       string             `json:"code"`
		EntityType string             `json:"entityType"`
		Count      int                `json:"count"`
		Motivation semiont.Motivation `json:"motivation"`
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
		noun, named := markNouns[flat.Motivation]
		if !named {
			return ""
		}
		return "Created " + plural(flat.Count, noun)
	default:
		return ""
	}
}
