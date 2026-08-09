package launcher

// yield.go — `semiont yield --upload`: register local files as KB
// resources via the generated packages/sdk-go client (multipart POST
// /resources, bearer token from `semiont login`), and `--delegate`:
// generation from gathered context, which rides the JOB lifecycle rather
// than a single request/reply (see runYieldDelegate below).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"
	"time"

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

Requires a session:  semiont login --email <address>
Generation from context: semiont yield --delegate --help
`

// extMediaTypes: the common cases, detected client-side like the npm CLI
// does. Anything unknown uploads as octet-stream — the backend's create
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
	u := newUI(false)
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
					u.fail("Missing value for %s", a)
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
					u.fail("Unknown argument: %s", a)
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
				u.fail("Missing value for --upload")
				return 1
			}
			uploads = append(uploads, args[i+1])
			i++
		case "--name":
			if i+1 >= len(args) {
				u.fail("Missing value for --name")
				return 1
			}
			name = args[i+1]
			i++
		case "--repo":
			if i+1 >= len(args) {
				u.fail("Missing value for --repo")
				return 1
			}
			repo = args[i+1]
			i++
		case "--runtime":
			if i+1 >= len(args) {
				u.fail("Missing value for --runtime")
				return 1
			}
			wantLocal = true
			i++
		case "--help", "-h":
			fmt.Print(yieldUsage)
			return 0
		default:
			u.fail("Unknown argument: %s", args[i])
			return 1
		}
	}
	if delegate {
		if len(positional) == 0 || len(positional) > 2 {
			fmt.Print(delegateUsage)
			return 1
		}
		if dopts.title == "" {
			u.fail("--delegate needs --title (GenerationJobParams requires one; the backend rejects a job without it).")
			return 1
		}
		if dopts.storageURI == "" {
			u.fail("--delegate needs --storage-uri (the generated resource must be given a home).")
			return 1
		}
		t, ok := verbSession(u, "yield", repo, wantLocal)
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
		u.fail("--name applies to a single --upload only.")
		return 1
	}

	ss := loadStackSet()
	target, ok := selectVerbStack(u, "yield", ss, repo, wantLocal)
	if !ok {
		return 1
	}
	base, key, root := "", "", ""
	if target != nil {
		base = fmt.Sprintf("http://localhost:%d", target.ForwardPort)
		key = "codespace:" + target.Repo
		// Storage URIs are repo-relative; for a codespace target the cwd's
		// clone is the only tree that can anchor them.
		root = cwdKBRoot()
		if root == "" {
			u.fail("yield --upload against a codespace needs a local clone of %s to anchor repo-relative paths.", target.Repo)
			fmt.Fprintln(os.Stderr, "  Run it from inside the clone.")
			return 1
		}
	} else {
		local := ss.Stacks["local"]
		if local == nil {
			u.fail("yield needs a running stack, and none is recorded.")
			fmt.Fprintln(os.Stderr, "  Start one first:  semiont start")
			return 1
		}
		base = backendBase(local)
		key = "local"
		root = local.KBRoot
		if root == "" {
			root = cwdKBRoot()
		}
		if root == "" {
			// A legacy record can lack KBRoot; refuse plainly rather than
			// let the path check babble about a KB root named "".
			u.fail("Cannot determine the KB root (the stack record predates root tracking, and the current directory is not inside a KB clone).")
			fmt.Fprintln(os.Stderr, "  Run yield from inside the KB clone, or set SEMIONT_ROOT.")
			return 1
		}
	}

	tok, haveTok := loadTokens()[key]
	if !haveTok || tok.Token == "" {
		u.fail("No session for %s.", key)
		fmt.Fprintln(os.Stderr, "  Log in first:  semiont login --email <address>")
		return 1
	}

	cli, err := semiont.NewClientWithResponses(base)
	if err != nil {
		u.fail("client: %v", err)
		return 1
	}
	for _, up := range uploads {
		if code := yieldOne(u, cli, key, &tok, root, up, name); code != 0 {
			return code
		}
	}
	return 0
}

// yieldOne validates, builds the multipart per the spec's schema (name,
// file, format, storageUri), and posts it. Fail-fast: the first refusal or
// error stops the batch — partial silent success is how uploads get lost.
// A 401 triggers ONE invisible refresh-and-retry (session.go) before the
// login fix-it — access tokens live an hour; that must be plumbing, not
// the user's problem.
func yieldOne(u *ui, cli *semiont.ClientWithResponses, key string, tok *tokenEntry, root, up, name string) int {
	abs := up
	if !filepath.IsAbs(abs) {
		if a, err := filepath.Abs(abs); err == nil {
			abs = a
		}
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		u.fail("%s is outside the KB root (%s) — storage URIs are repo-relative, and the content belongs in the repo.", up, root)
		fmt.Fprintf(os.Stderr, "  Copy it into the KB first:  cp %s %s/\n", up, root)
		return 1
	}
	content, err := os.ReadFile(abs)
	if err != nil {
		u.fail("cannot read %s: %v", up, err)
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
		u.fail("building upload for %s: %v", up, buildErr)
		return 1
	}

	body := buf.Bytes()
	for attempt := 0; ; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		resp, err := cli.PostResourcesWithBodyWithResponse(ctx, w.FormDataContentType(),
			bytes.NewReader(body), bearer(tok.Token))
		cancel()
		if err != nil {
			u.fail("Backend unreachable: %v", err)
			fmt.Fprintln(os.Stderr, "  Is the stack up?  semiont status")
			return 1
		}
		switch {
		case resp.JSON202 != nil:
			u.ok("Yielded: %s → %s", up, resp.JSON202.ResourceId)
			return 0
		case resp.JSON401 != nil:
			if attempt == 0 {
				if refreshed, ok := refreshSession(u, cli, key, *tok); ok {
					*tok = refreshed
					continue
				}
				u.fail("Session rejected and the refresh token could not renew it.")
			} else {
				// The refresh SUCCEEDED — saying it "could not renew" here
				// would contradict the Session-refreshed line just printed.
				u.fail("Session rejected even after a successful refresh — the backend no longer accepts this account's tokens.")
			}
			fmt.Fprintln(os.Stderr, "  Log in again:  semiont login --email <address>")
			return 1
		case resp.JSON400 != nil:
			u.fail("Backend rejected %s: %s", up, resp.JSON400.Error)
			return 1
		default:
			u.fail("Upload of %s failed: HTTP %d.", up, resp.HTTPResponse.StatusCode)
			return 1
		}
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

Requires a session:  semiont login --email <address>
`

func runYieldDelegate(u *ui, t verbTarget, positional []string, opts delegateOptions) int {
	cli := bus.NewClient(t.base, t.token)
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
			u.fail("yield --delegate: the gathered context could not be read.")
			return 1
		}
		gathered = gc.Response
	} else {
		req := semiont.GatherResourceRequest{ResourceId: resourceID}
		req.Options.IncludeContent = true
		req.Options.IncludeSummary = true
		reply, err := cli.Request(ctx, "gather:resource-requested", req, nil)
		if err != nil {
			return busFail(u, "yield --delegate (gather)", err)
		}
		var gc semiont.GatherResourceComplete
		if json.Unmarshal(reply, &gc) != nil {
			u.fail("yield --delegate: the gathered context could not be read.")
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
		u.fail("yield --delegate: the backend accepted the job but named no jobId.")
		return 1
	}
	jobID := jc.Response.JobId
	u.log("Generating %s", u.dim("(job "+jobID+")"))

	// Follow the job. A generation can run for minutes; narrate it rather
	// than leaving a silent terminal.
	for {
		select {
		case <-ctx.Done():
			return 1
		case ev, open := <-sub.Events:
			if !open {
				u.fail("The event stream closed before job %s finished.", jobID)
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
				// JobProgress is the one progress shape for every job type;
				// stage and message are always present. Narrating the stage
				// too is what makes a minutes-long generation legible.
				if p.Progress != nil {
					u.log("%s %s", p.Progress.Stage, u.dim(p.Progress.Message))
				}
			case "job:fail":
				var f semiont.JobFailCommand
				if json.Unmarshal(ev.Payload, &f) != nil || f.JobId != jobID {
					continue
				}
				u.fail("Generation failed: %s", f.Error)
				return 1
			case "job:complete":
				var done semiont.JobCompleteCommand
				if json.Unmarshal(ev.Payload, &done) != nil || done.JobId != jobID {
					continue
				}
				// A DECLINE is read first, and by its DISCRIMINANT. Every
				// generated As*() accessor is a bare json.Unmarshal with no
				// discriminant check, so a declined result decodes cleanly
				// into JobGenerationResult with an empty resource id —
				// indistinguishable, to the check below, from a generation
				// that simply had no id to print. Ordering alone would not
				// be enough either: AsJobDeclinedResult succeeds on a
				// generation too, with Declined false.
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
					u.fail("Declined (%s): %s", declined.Reason, declined.Message)
					fmt.Fprintf(os.Stderr, "  Nothing was written to %s.\n", opts.storageURI)
					return 1
				}
				// JobResult is a union over every job type; a generation names
				// the resource it produced.
				if done.Result != nil {
					if gen, err := done.Result.AsJobGenerationResult(); err == nil && gen.ResourceId != nil {
						u.ok("Yielded %s → %s %s", opts.storageURI, *gen.ResourceId, u.dim(gen.ResourceName))
						return 0
					}
				}
				u.ok("Yielded %s", opts.storageURI)
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
