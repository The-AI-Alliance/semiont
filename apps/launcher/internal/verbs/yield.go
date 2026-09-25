package verbs

// yield.go — `semiont yield --upload`: register local files as KB
// resources via the generated packages/sdk-go client (multipart POST
// /resources, bearer token from `semiont login`), and `--delegate`:
// generation from gathered context, which rides the JOB lifecycle rather
// than a single request/reply (see runYieldDelegate below).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

const yieldUsage = `Usage: semiont yield --upload <file> [--upload <file>...] [options]

Register local files as resources in a running stack's KB. Files must live
under the KB root: the storage URI is repo-relative, and the content
belongs in the repo (commit it — and the .semiont/events it creates).

Options:
  --upload <file>      File to upload (repeatable)
  --name <title>       Resource name (single --upload only; default: filename stem)
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly
  --help               Show this help

Requires a session:  semiont login
Generation from context: semiont yield --delegate --help
`

// extMediaTypes: the common cases, detected client-side like the npm CLI
// does. Anything unknown uploads as octet-stream — the gateway's create
// route stays the validator of record (big tent).
var extMediaTypes = map[string]string{
	".md": "text/markdown", ".markdown": "text/markdown",
	".txt": "text/plain", ".csv": "text/csv",
	".html": "text/html", ".htm": "text/html",
	".json": "application/json", ".pdf": "application/pdf",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif",
}

func Yield(args []string) int {
	u := launcher.NewUI(false)
	var uploads, positional []string
	name, repo, wantLocal := "", "", false
	delegate := false
	var dopts delegateOptions
	for i := 0; i < len(args); i++ {
		// --delegate takes its own option set; everything below stays the
		// upload path's.
		if delegate {
			a := args[i]
			val := func() (string, bool) {
				if i+1 >= len(args) {
					u.Fail("Missing value for %s", a)
					return "", false
				}
				i++
				return args[i], true
			}
			var ok bool
			switch a {
			case "--storage-uri":
				dopts.storageURI, ok = val()
			case "--title":
				dopts.title, ok = val()
			case "--prompt":
				dopts.prompt, ok = val()
			case "--language":
				dopts.language, ok = val()
			case "--task":
				dopts.task, ok = val()
			case "--structure":
				dopts.structure, ok = val()
			case "--repo":
				repo, ok = val()
			case "--runtime":
				_, ok = val()
				wantLocal = true
			case "--json":
				dopts.asJSON, ok = true, true
			case "--help", "-h":
				fmt.Print(delegateUsage)
				return 0
			default:
				if strings.HasPrefix(a, "-") {
					u.Fail("Unknown argument: %s", a)
					return 1
				}
				positional = append(positional, a)
				ok = true
			}
			if !ok {
				return 1
			}
			continue
		}
		switch args[i] {
		case "--delegate":
			delegate = true
		case "--upload":
			if i+1 >= len(args) {
				u.Fail("Missing value for --upload")
				return 1
			}
			uploads = append(uploads, args[i+1])
			i++
		case "--name":
			if i+1 >= len(args) {
				u.Fail("Missing value for --name")
				return 1
			}
			name = args[i+1]
			i++
		case "--repo":
			if i+1 >= len(args) {
				u.Fail("Missing value for --repo")
				return 1
			}
			repo = args[i+1]
			i++
		case "--runtime":
			if i+1 >= len(args) {
				u.Fail("Missing value for --runtime")
				return 1
			}
			wantLocal = true
			i++
		case "--help", "-h":
			fmt.Print(yieldUsage)
			return 0
		default:
			u.Fail("Unknown argument: %s", args[i])
			return 1
		}
	}
	if delegate {
		if len(positional) == 0 || len(positional) > 2 {
			fmt.Print(delegateUsage)
			return 1
		}
		if dopts.storageURI == "" {
			u.Fail("--delegate needs --storage-uri (the generated resource must be given a home).")
			return 1
		}
		if dopts.title == "" {
			u.Fail("--delegate needs --title: GenerationJobParams requires it, so the gateway rejects a job without one.")
			return 1
		}
		t, ok := launcher.VerbSession(u, "yield", repo, wantLocal)
		if !ok {
			return 1
		}
		return runYieldDelegate(u, t, positional, dopts)
	}
	if len(uploads) == 0 {
		fmt.Print(yieldUsage)
		return 1
	}
	if name != "" && len(uploads) > 1 {
		u.Fail("--name applies to a single --upload only.")
		return 1
	}

	ss := launcher.LoadStackSet()
	target, ok := launcher.SelectVerbStack(u, "yield", ss, repo, wantLocal)
	if !ok {
		return 1
	}
	base, key, root := "", "", ""
	if target != nil {
		base = fmt.Sprintf("http://localhost:%d", target.Codespace.ForwardPort)
		key = "codespace:" + target.Codespace.Repo
		// Storage URIs are repo-relative; for a codespace target the cwd's
		// clone is the only tree that can anchor them.
		root = launcher.CwdKBRoot()
		if root == "" {
			u.Fail("yield --upload against a codespace needs a local clone of %s to anchor repo-relative paths.", target.Codespace.Repo)
			fmt.Fprintln(os.Stderr, "  Run it from inside the clone.")
			return 1
		}
	} else {
		local := ss.Stacks["local"]
		if local == nil {
			u.Fail("yield needs a running stack, and none is recorded.")
			fmt.Fprintln(os.Stderr, "  Start one first:  semiont start")
			return 1
		}
		base = launcher.GatewayBase(local)
		key = "local"
		root = local.KBRoot
		if root == "" {
			root = launcher.CwdKBRoot()
		}
		if root == "" {
			// A legacy record can lack KBRoot; refuse plainly rather than
			// let the path check babble about a KB root named "".
			u.Fail("Cannot determine the KB root (the stack record predates root tracking, and the current directory is not inside a KB clone).")
			fmt.Fprintln(os.Stderr, "  Run yield from inside the KB clone, or set SEMIONT_ROOT.")
			return 1
		}
	}

	sess, ok := launcher.LoadSession(u, key)
	if !ok {
		return 1
	}

	cli, err := semiont.NewClientWithResponses(base)
	if err != nil {
		u.Fail("client: %v", err)
		return 1
	}
	for _, up := range uploads {
		if code := yieldOne(u, cli, sess, root, up, name); code != 0 {
			return code
		}
	}
	return 0
}

// yieldOne validates, builds the multipart per the spec's schema (name,
// file, format, storageUri), and posts it. Fail-fast: the first refusal or
// error stops the batch — partial silent success is how uploads get lost.
// The post runs under the session's renew-and-retry policy (session.go), the
// same one every bus verb's calls run under: an expired access token is
// plumbing, not the user's problem.
func yieldOne(u *launcher.UI, cli *semiont.ClientWithResponses, sess *launcher.Session, root, up, name string) int {
	abs := up
	if !filepath.IsAbs(abs) {
		if a, err := filepath.Abs(abs); err == nil {
			abs = a
		}
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		u.Fail("%s is outside the KB root (%s) — storage URIs are repo-relative, and the content belongs in the repo.", up, root)
		fmt.Fprintf(os.Stderr, "  Copy it into the KB first:  cp %s %s/\n", up, root)
		return 1
	}
	content, err := os.ReadFile(abs)
	if err != nil {
		u.Fail("cannot read %s: %v", up, err)
		return 1
	}
	rel = filepath.ToSlash(rel)
	if name == "" {
		b := filepath.Base(rel)
		name = strings.TrimSuffix(b, filepath.Ext(b))
	}
	format, ok := extMediaTypes[strings.ToLower(filepath.Ext(rel))]
	if !ok {
		format = "application/octet-stream"
	}

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if buildErr := func() error {
		if err := w.WriteField("name", name); err != nil {
			return err
		}
		if err := w.WriteField("format", format); err != nil {
			return err
		}
		if err := w.WriteField("storageUri", "file://"+rel); err != nil {
			return err
		}
		fw, err := w.CreateFormFile("file", filepath.Base(rel))
		if err != nil {
			return err
		}
		if _, err := fw.Write(content); err != nil {
			return err
		}
		return w.Close()
	}(); buildErr != nil {
		u.Fail("building upload for %s: %v", up, buildErr)
		return 1
	}

	body := buf.Bytes()
	var resp *semiont.PostResourcesResponse
	err = sess.Authorized(func(token string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		r, err := cli.PostResourcesWithBodyWithResponse(ctx, w.FormDataContentType(),
			bytes.NewReader(body), launcher.Bearer(token))
		if err != nil {
			return err
		}
		if r.StatusCode() == http.StatusUnauthorized {
			// The signal the bus client raises for the same answer, so the
			// session's one policy reads both wires the same way.
			return &bus.StatusError{Op: "POST /resources", Status: r.StatusCode()}
		}
		resp = r
		return nil
	})
	var rej *launcher.SessionRejected
	switch {
	case errors.As(err, &rej):
		return launcher.RejectedFail(u, "yield", rej)
	case err != nil:
		u.Fail("Gateway unreachable: %v", err)
		fmt.Fprintln(os.Stderr, "  Is the stack up?  semiont status")
		return 1
	}
	switch {
	case resp.JSON202 != nil:
		u.Ok("Yielded: %s → %s", up, resp.JSON202.ResourceId)
		return 0
	case resp.JSON400 != nil:
		u.Fail("Gateway rejected %s: %s", up, resp.JSON400.Error)
		return 1
	default:
		u.Fail("Upload of %s failed: HTTP %d.", up, resp.StatusCode())
		return 1
	}
}

// --- delegate mode: generation via the job lifecycle -------------------
//
// Unlike every other verb here, delegate is NOT one request/reply. It
// creates a job (job:create → job:created carries the jobId) and then
// follows job:report-progress / job:complete / job:fail, which are
// BROADCASTS correlated by jobId — not by the correlationId the bus client
// uses elsewhere. The subscription therefore opens BEFORE the job is
// created: the jobId is unknown at that moment, so events are buffered and
// filtered once it arrives. Subscribing after would race a fast job.

const delegateUsage = `Usage: semiont yield --delegate <resourceId> [<annotationId>] --storage-uri <file://…> [options]

Generate a new resource from gathered context: derived from a whole resource,
or anchored to one annotation.

Options:
  --storage-uri <uri>  Where the generated resource is written (required)
  --title <text>       Title for the generated resource (required)
  --prompt <text>      Instruction guiding the generation
  --language <tag>     BCP-47 language for the generated content
  --task <t>           Framing: resource | answer | summary (or free text)
  --structure <s>      Shape: prose | sections | chat (or free text)
  --json               Raw JSON completion event
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly

Requires a session:  semiont login
`

func runYieldDelegate(u *launcher.UI, t launcher.VerbTarget, positional []string, opts delegateOptions) int {
	cli := t.Transport()
	ctx := context.Background()
	resourceID := positional[0]

	// Gather the grounding context first — generation without it is the
	// thin-context failure mode the npm CLI documents.
	var gathered any
	if len(positional) == 2 {
		reply, err := cli.Request(ctx, "gather:requested", semiont.GatherAnnotationRequest{
			ResourceId: resourceID, AnnotationId: positional[1],
		}, nil)
		if err != nil {
			return busFail(u, "yield --delegate (gather)", err)
		}
		var gc semiont.GatherAnnotationComplete
		if json.Unmarshal(reply, &gc) != nil {
			u.Fail("yield --delegate: the gathered context could not be read.")
			return 1
		}
		gathered = gc.Response
	} else {
		req := semiont.GatherResourceRequest{ResourceId: resourceID}
		// Depth and maxResources are required by the schema. Left at Go's
		// zero, the librarian asked Qdrant for `limit: 0` and every delegate
		// died in this gather with a bare "Unprocessable Entity".
		req.Options.Depth = gatherDefaultDepth
		req.Options.MaxResources = gatherDefaultMaxResources
		req.Options.IncludeContent = true
		req.Options.IncludeSummary = true
		reply, err := cli.Request(ctx, "gather:resource-requested", req, nil)
		if err != nil {
			return busFail(u, "yield --delegate (gather)", err)
		}
		var gc semiont.GatherResourceComplete
		if json.Unmarshal(reply, &gc) != nil {
			u.Fail("yield --delegate: the gathered context could not be read.")
			return 1
		}
		gathered = gc.Response
	}

	// Subscribe BEFORE creating the job: the lifecycle events are broadcasts
	// keyed by a jobId that does not exist yet, so they are buffered here and
	// filtered below.
	sub, err := cli.Subscribe(ctx, []bus.Channel{"job:report-progress", "job:complete", "job:fail"}, nil, "")
	if err != nil {
		return busFail(u, "yield --delegate", err)
	}
	defer sub.Close()

	// GenerationJobParams requires title, storageUri and context; the rest are
	// optional and omitted when empty.
	params := map[string]any{"title": opts.title, "storageUri": opts.storageURI, "context": gathered}
	for k, v := range map[string]string{
		"prompt": opts.prompt, "language": opts.language,
		"task": opts.task, "structure": opts.structure,
	} {
		if v != "" {
			params[k] = v
		}
	}

	// The CONTEXT carries the ids now. For jobType generation the dispatcher
	// derives resourceId from params.context.focus and rejects a caller-supplied
	// one; referenceId left the params schema entirely and the worker derives it
	// the same way. So the envelope's ResourceId stays nil here — sending what we
	// know would be rejected, and the focus is authoritative anyway. The gather
	// above is what puts the right focus in the context: annotation-focused with
	// two positionals, resource-focused with one.
	created, err := cli.Request(ctx, "job:create", semiont.JobCreateCommand{
		JobType: semiont.JobType("generation"),
		Params:  params,
	}, nil)
	if err != nil {
		return busFail(u, "yield --delegate", err)
	}
	var jc semiont.JobCreatedResult
	if json.Unmarshal(created, &jc) != nil || jc.Response.JobId == "" {
		u.Fail("yield --delegate: the gateway accepted the job but named no jobId.")
		return 1
	}
	jobID := jc.Response.JobId
	u.Log("Generating %s", u.Dim("(job "+jobID+")"))

	// Follow the job. A generation can run for minutes; narrate it rather
	// than leaving a silent terminal.
	for {
		select {
		case <-ctx.Done():
			return 1
		case ev, open := <-sub.Events:
			if !open {
				u.Fail("The event stream closed before job %s finished.", jobID)
				fmt.Fprintln(os.Stderr, "  The job may still be running:  semiont browse "+resourceID)
				return 1
			}
			// Each job channel carries its own command schema, so each is read
			// with its own generated type. The lifecycle correlates by jobId —
			// these are broadcasts, and every viewer of the KB sees them.
			switch ev.Channel {
			case "job:report-progress":
				var p semiont.JobReportProgressCommand
				if json.Unmarshal(ev.Payload, &p) != nil || p.JobId != jobID {
					continue // another job's broadcast
				}
				// JobProgress is the one progress shape for every job type.
				// The wire carries a code + typed params, never a sentence —
				// each client owns its own words, and this terminal's are
				// English-only by design (ASSIST-PROGRESS-CONSOLIDATION P1).
				// Narrating the stage too is what makes a minutes-long
				// generation legible.
				if p.Progress != nil {
					// The CODE is the narration now. `stage` was removed as
					// redundant denormalization (P5) — every code mapped to
					// exactly one stage. An unrecognized or absent code prints
					// NOTHING rather than an empty bullet: the previous form
					// printed `stage` as the label with this as dim detail, so
					// when both were empty it emitted a bare "▸ " with no text.
					if text := progressText(p.Progress.Message); text != "" {
						u.Log("%s", u.Dim(text))
					}
				}
			case "job:fail":
				var f semiont.JobFailCommand
				if json.Unmarshal(ev.Payload, &f) != nil || f.JobId != jobID {
					continue
				}
				u.Fail("Generation failed: %s", f.Error)
				return 1
			case "job:complete":
				var done semiont.JobCompleteCommand
				if json.Unmarshal(ev.Payload, &done) != nil || done.JobId != jobID {
					continue
				}
				// A DECLINE is read first, and by its DISCRIMINANT. Every
				// generated As*() accessor is a bare json.Unmarshal with no
				// discriminant check, so a declined result decodes cleanly
				// into JobGenerationResult with a zero-value resource id.
				// A real generation ALWAYS carries the id (the worker holds
				// it before job:complete — the schema requires it), so the
				// empty check below is a decline-detector, not a missing-id
				// fallback. Ordering alone would not be enough either:
				// AsJobDeclinedResult succeeds on a generation too, with
				// Declined false.
				declined, ok := declinedResult(done.Result)
				if opts.asJSON {
					fmt.Println(string(ev.Payload))
					// The exit code is a property of the outcome, not of the
					// output format.
					if ok {
						return 1
					}
					return 0
				}
				if ok {
					// Not a failure — the job ran correctly and found nothing
					// to work with, so this is deliberately not the job:fail
					// wording. Non-zero all the same: the caller asked for a
					// resource and has none, and nothing downstream of a
					// `yield --delegate && ...` should run.
					u.Fail("Declined (%s): %s", declined.Reason, declineText(declined.Reason))
					fmt.Fprintf(os.Stderr, "  Nothing was written to %s.\n", opts.storageURI)
					return 1
				}
				// JobResult is a union over every job type; a generation names
				// the resource it produced.
				if done.Result != nil {
					if gen, err := done.Result.AsJobGenerationResult(); err == nil && gen.ResourceId != "" {
						u.Ok("Yielded %s → %s %s", opts.storageURI, gen.ResourceId, u.Dim(gen.ResourceName))
						return 0
					}
				}
				u.Ok("Yielded %s", opts.storageURI)
				return 0
			}
		}
	}
}

// declinedResult reads the DECLINE member out of a JobResult, and reports
// false for every shape that actually did the work.
//
// The discriminant is what makes this safe, and it has to be checked
// explicitly: oapi-codegen's As*() accessors are bare json.Unmarshal calls
// with no discriminant test, so every union member "decodes" successfully
// against every other member's payload. AsJobDeclinedResult on a generation
// result returns a zero-valued struct — err nil, Declined false. Only the
// schema's `"declined": true` const separates the two, so only reading it
// tells them apart.
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
// discriminant check (see the decline handling below for that lesson).
// An unknown or absent code renders "" and the caller falls back to the
// stage — new codes degrade legibly instead of breaking old launchers.
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

func declinedResult(r *semiont.JobResult) (semiont.JobDeclinedResult, bool) {
	if r == nil {
		return semiont.JobDeclinedResult{}, false
	}
	d, err := r.AsJobDeclinedResult()
	if err != nil || !bool(d.Declined) {
		return semiont.JobDeclinedResult{}, false
	}
	return d, true
}

type delegateOptions struct {
	storageURI, title, prompt, language, task, structure string
	asJSON                                               bool
}
