package launcher

// gather.go — `semiont gather`: assemble LLM-optimized context for a
// resource or an annotation. Resource-focus is a plain request/reply;
// annotation-focus is a STREAMING operation (gather:requested carries a
// progress channel), so the wait narrates itself instead of hanging silent.

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

const gatherUsage = `Usage: semiont gather <resourceId> [options]
       semiont gather <resourceId> <annotationId> [options]

Assemble context for an LLM: the resource with its neighbourhood, or the
context surrounding one annotation.

Options:
  --depth <n>          Resource-graph traversal depth
  --max-resources <n>  Cap on related resources
  --no-content         Omit resource content (metadata only)
  --summary            Include summaries
  --json               Raw JSON reply instead of a summary
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly
  --help               Show this help

Requires a session:  semiont login --email <address>
`

func Gather(args []string) int {
	u := newUI(false)
	var positional []string
	var repo string
	depth, maxResources := 0, 0
	noContent, summary, asJSON, wantLocal := false, false, false, false

	for i := 0; i < len(args); i++ {
		a := args[i]
		num := func() (int, bool) {
			if i+1 >= len(args) {
				u.fail("Missing value for %s", a)
				return 0, false
			}
			i++
			n, err := strconv.Atoi(args[i])
			if err != nil || n < 0 {
				u.fail("%s wants a number, got %q", a, args[i])
				return 0, false
			}
			return n, true
		}
		switch a {
		case "--depth":
			n, ok := num()
			if !ok {
				return 1
			}
			depth = n
		case "--max-resources":
			n, ok := num()
			if !ok {
				return 1
			}
			maxResources = n
		case "--repo":
			if i+1 >= len(args) {
				u.fail("Missing value for --repo")
				return 1
			}
			i++
			repo = args[i]
		case "--runtime":
			if i+1 >= len(args) {
				u.fail("Missing value for --runtime")
				return 1
			}
			i++
			wantLocal = true
		case "--no-content":
			noContent = true
		case "--summary":
			summary = true
		case "--json":
			asJSON = true
		case "--help", "-h":
			fmt.Print(gatherUsage)
			return 0
		default:
			if strings.HasPrefix(a, "-") {
				u.fail("Unknown argument: %s", a)
				return 1
			}
			positional = append(positional, a)
		}
	}
	if len(positional) == 0 || len(positional) > 2 {
		fmt.Print(gatherUsage)
		return 1
	}

	t, ok := verbSession(u, "gather", repo, wantLocal)
	if !ok {
		return 1
	}
	cli := bus.NewClient(t.base, t.token)

	options := map[string]any{"includeContent": !noContent, "includeSummary": summary}
	if depth > 0 {
		options["depth"] = depth
	}
	if maxResources > 0 {
		options["maxResources"] = maxResources
	}

	var op bus.Channel
	payload := map[string]any{"resourceId": positional[0], "options": options}
	if len(positional) == 2 {
		op = "gather:requested" // annotation focus — streaming
		payload["annotationId"] = positional[1]
	} else {
		op = "gather:resource-requested"
	}

	opts := &bus.RequestOptions{}
	if !asJSON && bus.Operations[op].Streaming() {
		// A gather can take a while; say what it is doing rather than
		// leaving a silent terminal (the codespace-wait lesson).
		opts.Progress = func(_ bus.Channel, payload []byte) {
			var p struct {
				Step    string `json:"step"`
				Message string `json:"message"`
			}
			_ = json.Unmarshal(payload, &p)
			switch {
			case p.Message != "":
				u.log("%s", p.Message)
			case p.Step != "":
				u.log("gathering: %s", p.Step)
			}
		}
	}

	reply, err := cli.Request(context.Background(), op, payload, opts)
	if err != nil {
		return busFail(u, "gather", err)
	}
	if asJSON {
		fmt.Println(string(reply))
		return 0
	}

	var env struct {
		Response json.RawMessage `json:"response"`
	}
	if json.Unmarshal(reply, &env) != nil || len(env.Response) == 0 {
		env.Response = reply
	}
	var ctxDoc struct {
		Content   string            `json:"content"`
		Summary   string            `json:"summary"`
		Resources []json.RawMessage `json:"resources"`
		Metadata  struct {
			Language string `json:"language"`
			Tokens   int    `json:"tokens"`
		} `json:"metadata"`
	}
	if json.Unmarshal(env.Response, &ctxDoc) != nil {
		return rawFallback(env.Response)
	}
	// A summary, not the payload: the content is LLM input, often huge, and
	// dumping it into a terminal by default helps nobody. --json is the
	// pipe-it-somewhere path.
	if ctxDoc.Summary != "" {
		fmt.Printf("  %s\n\n", ctxDoc.Summary)
	}
	fmt.Printf("  %s\n", u.dim(fmt.Sprintf("%d related resource(s), %d chars of content%s",
		len(ctxDoc.Resources), len(ctxDoc.Content), tokenNote(ctxDoc.Metadata.Tokens))))
	fmt.Printf("  %s\n", u.dim("full context: add --json"))
	return 0
}

func tokenNote(tokens int) string {
	if tokens == 0 {
		return ""
	}
	return fmt.Sprintf(", ~%d tokens", tokens)
}
