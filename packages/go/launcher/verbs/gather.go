package verbs

// gather.go — `semiont gather`: assemble LLM-optimized context for a
// resource or an annotation. Either focus is a plain request/reply.

import (
	"fmt"
	"strconv"
	"strings"

	launcher "github.com/The-AI-Alliance/semiont/packages/go/launcher"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

const gatherIDs = "semiont gather [options] -- <resourceId> [<annotationId>]"

const gatherUsage = `Usage: semiont gather <resourceId> [options]
       semiont gather <resourceId> <annotationId> [options]

Assemble context for an LLM: the resource with its neighbourhood, or the
context surrounding one annotation.

Options:
  --resource <id>      The resource (bare: first)
  --annotation <id>    One annotation in it, for that annotation's context (bare: second)
  --depth <n>          Links out from the resource the graph reaches, 1 to 3 (default 2)
  --max-resources <n>  Cap on related resources (resource focus; default 10)
  --context-window <n> Text on each side of the annotation, in code points (annotation focus)
  --no-content         Omit resource content (metadata only)
  --summary            Include summaries
  --json               Raw JSON reply instead of a summary
  --repo <owner/name>  Target a codespace stack
  --root <path>        Target the stack of the knowledge base at path
  --runtime <rt>       Target a stack here
  --help               Show this help

` + idsOrder + `

` + idsNote + `
  ` + gatherIDs + `

Requires a session:  semiont login
`

// Resource-gather values when the caller names none — the same ones the TS
// SDK's gather.resource() applies. GatherResourceRequest requires both fields,
// so a zero-valued struct puts depth 0 / maxResources 0 on the wire, and a
// maxResources of 0 reaches Qdrant as `limit: 0`, which it refuses (422).
const (
	gatherDefaultDepth        = 2
	gatherDefaultMaxResources = 10
)

func Gather(args []string) int {
	u := launcher.NewUI(false)
	var positional []string
	var resourceID, annotationID, repo string
	depth, maxResources, contextWindow := gatherDefaultDepth, gatherDefaultMaxResources, 0
	noContent, summary, asJSON, wantLocal := false, false, false, false
	rootFlag := ""

options:
	for i := 0; i < len(args); i++ {
		a := args[i]
		val := func() (string, bool) {
			if i+1 >= len(args) {
				u.Fail("Missing value for %s", a)
				return "", false
			}
			i++
			return args[i], true
		}
		num := func() (int, bool) {
			if i+1 >= len(args) {
				u.Fail("Missing value for %s", a)
				return 0, false
			}
			i++
			n, err := strconv.Atoi(args[i])
			if err != nil || n < 0 {
				u.Fail("%s wants a number, got %q", a, args[i])
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
		case "--resource":
			if !idValue(u, "resource", val, &resourceID) {
				return 1
			}
		case "--annotation":
			if !idValue(u, "annotation", val, &annotationID) {
				return 1
			}
		case "--repo":
			if i+1 >= len(args) {
				u.Fail("Missing value for --repo")
				return 1
			}
			i++
			repo = args[i]
		case "--root":
			if i+1 >= len(args) {
				u.Fail("Missing value for --root")
				return 1
			}
			rootFlag = args[i+1]
			i++
		case "--runtime":
			if i+1 >= len(args) {
				u.Fail("Missing value for --runtime")
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
		case "--":
			// Every word after it is an id, whatever it begins with.
			positional = append(positional, args[i+1:]...)
			break options
		case "--help", "-h":
			fmt.Print(gatherUsage)
			return 0
		default:
			if strings.HasPrefix(a, "-") {
				return unknownArgument(u, a, gatherIDs)
			}
			positional = append(positional, a)
		}
	}
	if !fillIDs(u, gatherIDs, positional, &resourceID, &annotationID) {
		return 1
	}
	if resourceID == "" {
		fmt.Print(gatherUsage)
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

	sess, ok := launcher.VerbSession(u, "gather", repo, rootFlag, wantLocal)
	if !ok {
		return 1
	}
	defer sess.Close()
	c := sess.Client()
	if err := c.Reached(); err != nil {
		return busFail(u, "gather", err)
	}

	// The two gathers take DIFFERENT option sets — the resource variant
	// traverses a graph, the annotation variant windows text around a mark.
	var gathered api.GatheredContext
	if annotationID != "" {
		complete, err := c.Gather.Annotation(rid, aid, windowed(contextWindow)).Wait(c.Context())
		if err != nil {
			return busFail(u, "gather", c.Refusal(err))
		}
		gathered = complete.Response
	} else {
		var err error
		gathered, err = c.Gather.Resource(c.Context(), rid, api.GatherResourceRequestOptions{
			Depth: depth, MaxResources: maxResources, IncludeContent: !noContent, IncludeSummary: summary,
		})
		if err != nil {
			return busFail(u, "gather", c.Refusal(err))
		}
	}
	if asJSON {
		return printJSON(u, gathered)
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
		fmt.Printf("  %s\n", u.Dim(strings.Join(bits, " · ")))
	}
	fmt.Printf("  %s\n", u.Dim("full context: add --json"))
	return 0
}

// windowed is what a gather of an annotation's context is given that takes
// contextWindow characters on each side of it: the SDK's own window when
// contextWindow is zero, which no gather can be given.
func windowed(contextWindow int) api.GatherAnnotationOptions {
	if contextWindow == 0 {
		return api.GatherAnnotationOptions{}
	}
	return api.GatherAnnotationOptions{ContextWindow: &contextWindow}
}
