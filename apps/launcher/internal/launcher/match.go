package launcher

// match.go — `semiont match`: find candidate resources an annotation could
// bind to. Two bus exchanges, in the order the npm CLI uses: gather the
// annotation's context first, then hand that context to the scored search.
// The gather is not an optimization — match:search-requested REQUIRES a
// context payload, so skipping it would just be a rejected request.

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

const matchUsage = `Usage: semiont match <resourceId> <annotationId> [options]

Search for resources this annotation could bind to. Gathers the annotation's
context, then runs a scored search over the KB.

Options:
  --limit <n>          Maximum candidates (default 10)
  --no-semantic        Skip semantic scoring (lexical only)
  --json               Raw JSON reply
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly
  --help               Show this help

Requires a session:  semiont login --email <address>
`

func Match(args []string) int {
	u := newUI(false)
	var positional []string
	var repo string
	limit := 10
	noSemantic, asJSON, wantLocal := false, false, false

	for i := 0; i < len(args); i++ {
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
		case "--limit":
			var v string
			v, ok = val()
			if ok {
				n, err := strconv.Atoi(v)
				if err != nil || n < 1 {
					u.fail("--limit wants a positive number, got %q", v)
					return 1
				}
				limit = n
			}
		case "--repo":
			repo, ok = val()
		case "--runtime":
			_, ok = val()
			wantLocal = true
		case "--no-semantic":
			noSemantic, ok = true, true
		case "--json":
			asJSON, ok = true, true
		case "--help", "-h":
			fmt.Print(matchUsage)
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
	}
	if len(positional) != 2 {
		fmt.Print(matchUsage)
		return 1
	}
	resourceID, annotationID := positional[0], positional[1]

	t, ok := verbSession(u, "match", repo, wantLocal)
	if !ok {
		return 1
	}
	cli := bus.NewClient(t.base, t.token)
	ctx := context.Background()

	// Step 1: the annotation's context (streaming operation).
	u.log("Gathering context for %s...", annotationID)
	gathered, err := cli.Request(ctx, "gather:requested", map[string]any{
		"resourceId":   resourceID,
		"annotationId": annotationID,
	}, nil)
	if err != nil {
		return busFail(u, "match (gather step)", err)
	}
	var genv struct {
		Response json.RawMessage `json:"response"`
	}
	if json.Unmarshal(gathered, &genv) != nil || len(genv.Response) == 0 {
		genv.Response = gathered
	}
	var contextDoc any
	if json.Unmarshal(genv.Response, &contextDoc) != nil {
		u.fail("match: the gathered context could not be read.")
		return 1
	}

	// Step 2: the scored search, grounded by that context.
	reply, err := cli.Request(ctx, "match:search-requested", map[string]any{
		"resourceId":         resourceID,
		"referenceId":        annotationID,
		"context":            contextDoc,
		"limit":              limit,
		"useSemanticScoring": !noSemantic,
	}, nil)
	if err != nil {
		return busFail(u, "match", err)
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
	var results struct {
		Candidates []struct {
			ID    string  `json:"id"`
			Name  string  `json:"name"`
			Score float64 `json:"score"`
		} `json:"candidates"`
		Resources []struct {
			ID    string  `json:"id"`
			Name  string  `json:"name"`
			Score float64 `json:"score"`
		} `json:"resources"`
	}
	if json.Unmarshal(env.Response, &results) != nil {
		return rawFallback(env.Response)
	}
	rows := results.Candidates
	if len(rows) == 0 {
		rows = results.Resources
	}
	if len(rows) == 0 {
		u.log("No candidates found.")
		return 0
	}
	for _, r := range rows {
		score := ""
		if r.Score != 0 {
			score = u.dim(fmt.Sprintf("%.3f", r.Score))
		}
		fmt.Printf("  %-28s %-40s %s\n", r.ID, r.Name, score)
	}
	fmt.Printf("\n  %s\n", u.dim(fmt.Sprintf("%d candidate(s) — bind one with: semiont bind %s %s <resourceId>",
		len(rows), resourceID, annotationID)))
	return 0
}
