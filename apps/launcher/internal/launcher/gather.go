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

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

const gatherUsage = `Usage: semiont gather <resourceId> [options]
       semiont gather <resourceId> <annotationId> [options]

Assemble context for an LLM: the resource with its neighbourhood, or the
context surrounding one annotation.

Options:
  --depth <n>          Resource-graph traversal depth
  --max-resources <n>  Cap on related resources (resource focus)
  --context-window <n> Characters of text around the annotation (annotation focus)
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
	depth, maxResources, contextWindow := 0, 0, 0
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
		case "--context-window":
			n, ok := num()
			if !ok {
				return 1
			}
			contextWindow = n
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

	// The two gathers take DIFFERENT option sets — the resource variant
	// traverses a graph, the annotation variant windows text around a mark.
	// Sending one blob to both (what the untyped version did) silently fed
	// each the other's fields.
	var op bus.Channel
	var payload any
	if len(positional) == 2 {
		op = "gather:requested" // annotation focus — streaming
		req := semiont.GatherAnnotationRequest{
			ResourceId:   positional[0],
			AnnotationId: positional[1],
		}
		if contextWindow > 0 {
			req.Options = &semiont.GatherAnnotationOptions{ContextWindow: &contextWindow}
		}
		payload = req
	} else {
		op = "gather:resource-requested"
		req := semiont.GatherResourceRequest{ResourceId: positional[0]}
		req.Options.IncludeContent = !noContent
		req.Options.IncludeSummary = summary
		req.Options.Depth = depth
		req.Options.MaxResources = maxResources
		payload = req
	}

	opts := &bus.RequestOptions{}
	if !asJSON && bus.Operations[op].Streaming() {
		// Narrate the wait rather than leaving a silent terminal (the
		// codespace-wait lesson). GatherProgress carries message+percentage —
		// there is no "step" field, whatever the earlier hand-rolled struct
		// claimed.
		opts.Progress = func(_ bus.Channel, raw []byte) {
			var p semiont.GatherProgress
			if json.Unmarshal(raw, &p) != nil || p.Message == nil {
				return
			}
			if p.Percentage != nil {
				u.log("%s (%.0f%%)", *p.Message, *p.Percentage)
				return
			}
			u.log("%s", *p.Message)
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

	// GENERATED reply types model the whole envelope (correlationId +
	// response), so there is no hand-rolled unwrapping — and no chance of
	// guessing a field name the schema never had.
	var gathered semiont.GatheredContext
	if len(positional) == 2 {
		var r semiont.GatherAnnotationComplete
		if json.Unmarshal(reply, &r) != nil {
			return rawFallback(reply)
		}
		gathered = r.Response
	} else {
		var r semiont.GatherResourceComplete
		if json.Unmarshal(reply, &r) != nil {
			return rawFallback(reply)
		}
		gathered = r.Response
	}
	// `summary` is already the --summary flag; this is the gathered prose.
	relSummary := ""
	if gathered.InferredRelationshipSummary != nil {
		relSummary = *gathered.InferredRelationshipSummary
	}
	// Focus is a discriminated union in the schema, not a plain field —
	// summarize from the metadata the context always carries instead.
	var bits []string
	if gathered.Metadata.ResourceType != nil {
		bits = append(bits, *gathered.Metadata.ResourceType)
	}
	if gathered.Metadata.Language != nil {
		bits = append(bits, *gathered.Metadata.Language)
	}
	if gathered.Metadata.EntityTypes != nil && len(*gathered.Metadata.EntityTypes) > 0 {
		bits = append(bits, fmt.Sprintf("%d entity type(s)", len(*gathered.Metadata.EntityTypes)))
	}

	// A summary, not the payload: the context is LLM input, often huge, and
	// dumping it into a terminal by default helps nobody. --json is the
	// pipe-it-somewhere path.
	if relSummary != "" {
		fmt.Printf("  %s\n\n", relSummary)
	}
	if len(bits) > 0 {
		fmt.Printf("  %s\n", u.dim(strings.Join(bits, " · ")))
	}
	fmt.Printf("  %s\n", u.dim("full context: add --json"))
	return 0
}
