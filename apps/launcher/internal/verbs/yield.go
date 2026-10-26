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
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/mediatypes"
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

func Yield(args []string) int {
	u := launcher.NewUI(false)
	var uploads, positional []string
	var resourceID, annotationID string
	name, repo, wantLocal := "", "", false
	delegate, asJSON := false, false
	// given: what the job flags gave, by the name of the parameter each gives.
	given := map[string]any{}
options:
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
			if taken, ok := yieldJobFlags.take(u, a, val, given); taken {
				if !ok {
					return 1
				}
				continue
			}
			var ok bool
			switch a {
			case "--resource":
				ok = idValue(u, "resource", val, &resourceID)
			case "--annotation":
				ok = idValue(u, "annotation", val, &annotationID)
			case "--repo":
				repo, ok = val()
			case "--runtime":
				_, ok = val()
				wantLocal = true
			case "--json":
				asJSON, ok = true, true
			case "--":
				// Every word after it is an id, whatever it begins with.
				positional = append(positional, args[i+1:]...)
				break options
			case "--help", "-h":
				fmt.Print(delegateUsage)
				return 0
			default:
				if strings.HasPrefix(a, "-") {
					return unknownArgument(u, a, yieldIDs)
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
		if !fillIDs(u, yieldIDs, positional, &resourceID, &annotationID) {
			return 1
		}
		if resourceID == "" {
			fmt.Print(delegateUsage)
			return 1
		}
		// What the job is asked to make is read before anything is gathered:
		// a job the gateway would refuse is refused here, before the caller
		// has paid for a gather.
		var request api.GenerationJobRequest
		if err := jobParams(given, yieldJobFlags, &request, "--delegate"); err != nil {
			u.Fail("%v", err)
			fmt.Fprintln(os.Stderr, "  semiont yield --delegate --help")
			return 1
		}
		rid, ok := parsed(u, "resource", resourceID, api.ParseResourceId)
		if !ok {
			return 1
		}
		var aid api.AnnotationId
		if annotationID != "" {
			if aid, ok = parsed(u, "annotation", annotationID, api.ParseAnnotationId); !ok {
				return 1
			}
		}
		t, ok := launcher.VerbSession(u, "yield", repo, wantLocal)
		if !ok {
			return 1
		}
		return runYieldDelegate(u, t, rid, aid, request, asJSON)
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
		if base, ok = launcher.ForwardedBase(u, target, "yield"); !ok {
			return 1
		}
		key = "codespace:" + target.Codespace.Repo
		// Storage URIs are repo-relative; for a codespace target the cwd's
		// clone is the only tree that can anchor them.
		var err error
		if root, err = launcher.CwdKBRoot(); err != nil {
			u.Fail("%v", err)
			return 1
		}
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
			var err error
			if root, err = launcher.CwdKBRoot(); err != nil {
				u.Fail("%v", err)
				return 1
			}
		}
		if root == "" {
			// A record can lack KBRoot; refuse plainly rather than let the
			// path check babble about a KB root named "".
			u.Fail("Cannot determine the KB root (the stack record predates root tracking, and the current directory is not inside a KB clone).")
			fmt.Fprintln(os.Stderr, "  Run yield from inside the KB clone, or set SEMIONT_ROOT.")
			return 1
		}
	}

	sess, ok := launcher.LoadSession(u, key, base)
	if !ok {
		return 1
	}

	cli, err := api.NewClientWithResponses(base)
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
// The post runs under the session's renew-and-retry policy (session.go),
// which renews with the same refresh-token grant a bus verb's transport asks
// the session for: an expired access token is plumbing, not the user's
// problem.
func yieldOne(u *launcher.UI, cli *api.ClientWithResponses, sess *launcher.Session, root, up, name string) int {
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
	// The format the extension names in the media-type registry. An
	// extension no row states uploads as octet-stream: the gateway's create
	// route stays the validator of record.
	format, ok := mediatypes.ForExtension(filepath.Ext(rel))
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
	var resp *api.UploadResourceResponse
	err = sess.Authorized(func(token string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		r, err := cli.UploadResourceWithBodyWithResponse(ctx, w.FormDataContentType(),
			bytes.NewReader(body), launcher.Bearer(token))
		if err != nil {
			return err
		}
		if r.StatusCode() == http.StatusUnauthorized {
			// The SDK's own word for the same answer, which the session's
			// policy reads.
			return &semiont.TransportError{Code: semiont.TransportErrorCodeUnauthorized, Message: "POST /resources 401"}
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
// Unlike the upload above, delegate is not one request and its reply: it
// gathers context, creates a generation job, and follows it (job.go).

const yieldIDs = "semiont yield --delegate [options] -- <resourceId> [<annotationId>]"

const delegateUsage = `Usage: semiont yield --delegate <resourceId> [<annotationId>] --storage-uri <file://…> [options]

Generate a new resource from gathered context: derived from a whole resource,
or anchored to one annotation.

Options:
  --resource <id>      The resource to generate from (bare: first)
  --annotation <id>    One annotation in it to anchor the result to (bare: second)
  --storage-uri <uri>  Where the generated resource is written (required)
  --title <text>       Title for the generated resource (required)
  --prompt <text>      Instruction guiding the generation
  --language <tag>     BCP-47 language for the generated content
  --task <t>           Framing: resource | answer | summary (or free text)
  --structure <s>      Shape: prose | sections | chat (or free text)
  --json               Raw JSON completion event
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly

` + idsOrder + `

` + idsNote + `
  ` + yieldIDs + `

Requires a session:  semiont login
`

// yieldJobFlags: the flag that gives each parameter of a delegated yield's
// job that a caller gives. Its context is gathered. Which of them the job
// requires is the generated GenerationJobRequest's to say (jobParams), and
// TestEveryYieldJobFlagGivesAParameter holds this table to it.
var yieldJobFlags = jobFlags{
	"--storage-uri": {"storageUri", flagText},
	"--title":       {"title", flagText},
	"--prompt":      {"prompt", flagText},
	"--language":    {"language", flagText},
	"--task":        {"task", flagText},
	"--structure":   {"structure", flagText},
}

// yieldJobResults: what a `yield` job reports.
var yieldJobResults = resultMembers[api.YieldJobResult]{
	{api.YieldJobDone{}, "the resource a yield job made"},
	declinedResult,
}

func runYieldDelegate(u *launcher.UI, t launcher.VerbTarget, resourceID api.ResourceId, annotationID api.AnnotationId, request api.GenerationJobRequest, asJSON bool) int {
	b := t.Bus(jobChannels...)
	defer b.Close()

	// Gather the grounding context first: a generation job requires it, and
	// its focus names the resource or annotation the generation is about.
	var gathered api.GatheredContext
	if !annotationID.IsZero() {
		reply, err := b.Request("gather:requested", api.GatherAnnotationRequest{
			ResourceId: resourceID, AnnotationId: annotationID,
		}, requestWithin)
		if err != nil {
			return busFail(u, "yield --delegate (gather)", err)
		}
		var gc api.GatherAnnotationComplete
		if json.Unmarshal(reply, &gc.Response) != nil {
			u.Fail("yield --delegate: the gathered context could not be read.")
			return 1
		}
		gathered = gc.Response
	} else {
		req := api.GatherResourceRequest{ResourceId: resourceID}
		// Depth and maxResources are required by the schema. Left at Go's
		// zero, the librarian asks Qdrant for `limit: 0` and the delegate
		// dies in this gather with a bare "Unprocessable Entity".
		req.Options.Depth = gatherDefaultDepth
		req.Options.MaxResources = gatherDefaultMaxResources
		req.Options.IncludeContent = true
		req.Options.IncludeSummary = true
		reply, err := b.Request("gather:resource-requested", req, requestWithin)
		if err != nil {
			return busFail(u, "yield --delegate (gather)", err)
		}
		var gc api.GatherResourceComplete
		if json.Unmarshal(reply, &gc.Response) != nil {
			u.Fail("yield --delegate: the gathered context could not be read.")
			return 1
		}
		gathered = gc.Response
	}

	// A yield job's parameters are what it is asked to make and the context it
	// is made from. The context carries the ids: the dispatcher derives the
	// job's resource from its focus, so the command names none. The gather
	// above is what puts the right focus there: an annotation's with two
	// positionals, a resource's with one.
	var params api.GenerationJobParams
	asked, err := json.Marshal(request)
	if err == nil {
		err = json.Unmarshal(asked, &params)
	}
	var create api.JobCreateCommand
	if err == nil {
		params.Context = gathered
		err = create.FromYieldJobCreateCommand(api.YieldJobCreateCommand{Params: params})
	}
	if err != nil {
		u.Fail("yield --delegate: the job could not be described: %v", err)
		return 1
	}
	job := delegatedJob[api.YieldJobCompleteCommand]{
		verb: "yield --delegate", doing: "Generating", failed: "Generation",
		check:  "semiont browse " + resourceID.String(),
		create: create,
		jobOf:  func(done api.YieldJobCompleteCommand) api.JobId { return done.JobId },
	}
	done, raw, ok := job.run(u, b)
	if !ok {
		return 1
	}
	// A decline is read first: the job ran and produced nothing, so there is
	// no resource to name.
	result, err := jobResult(done.Result, yieldJobResults)
	if err != nil {
		return job.resultFail(u, done.JobId, err)
	}
	declined, isDecline := result.(api.JobDeclined)
	if asJSON {
		fmt.Println(string(raw))
		// The exit code is a property of the outcome, not of the output
		// format.
		if isDecline {
			return 1
		}
		return 0
	}
	if isDecline {
		// Not a failure — the job ran correctly and found nothing to work
		// with, so this is deliberately not the job:fail wording. Non-zero
		// all the same: the caller asked for a resource and has none, and
		// nothing downstream of a `yield --delegate && ...` should run.
		u.Fail("Declined (%s): %s", declined.Reason, declineText(declined.Reason))
		fmt.Fprintf(os.Stderr, "  Nothing was written to %s.\n", request.StorageUri)
		return 1
	}
	// A generation names the resource it produced.
	if generated, ok := result.(api.YieldJobDone); ok {
		u.Ok("Yielded %s → %s %s", request.StorageUri, generated.ResourceId, u.Dim(generated.ResourceName))
		return 0
	}
	u.Ok("Yielded %s", request.StorageUri)
	return 0
}
