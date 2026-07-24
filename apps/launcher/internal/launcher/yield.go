package launcher

// yield.go — `semiont yield --upload`: register local files as KB
// resources via the generated packages/sdk-go client (multipart POST
// /resources, bearer token from `semiont login`). UPLOAD ONLY by design:
// --delegate (LLM generation from gathered context) stays with the npm
// CLI — its gather/observable orchestration lives in the TypeScript SDK,
// and porting it would be the double maintenance the sdk-go decision
// exists to avoid.

import (
	"bytes"
	"context"
	"fmt"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
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
Delegate mode (LLM generation from context) lives in the in-container CLI.
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
	var uploads []string
	name, repo, wantLocal := "", "", false
	for i := 0; i < len(args); i++ {
		switch args[i] {
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
		if code := yieldOne(u, cli, tok.Token, root, up, name); code != 0 {
			return code
		}
	}
	return 0
}

// yieldOne validates, builds the multipart per the spec's schema (name,
// file, format, storageUri), and posts it. Fail-fast: the first refusal or
// error stops the batch — partial silent success is how uploads get lost.
func yieldOne(u *ui, cli *semiont.ClientWithResponses, token, root, up, name string) int {
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
	_ = w.WriteField("name", name)
	_ = w.WriteField("format", format)
	_ = w.WriteField("storageUri", "file://"+rel)
	fw, err := w.CreateFormFile("file", filepath.Base(rel))
	if err == nil {
		_, err = fw.Write(content)
	}
	if err == nil {
		err = w.Close()
	}
	if err != nil {
		u.fail("building upload for %s: %v", up, err)
		return 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	resp, err := cli.PostResourcesWithBodyWithResponse(ctx, w.FormDataContentType(), &buf,
		func(_ context.Context, req *http.Request) error {
			req.Header.Set("Authorization", "Bearer "+token)
			return nil
		})
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
		u.fail("Session rejected (expired?).")
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
