package verbs

// match.go — `semiont match`: search the knowledge base. Two forms, one
// per question:
//
//	semiont match --search <text>               resources by text
//	semiont match <resourceId> <annotationId>   candidates an annotation could bind to
//
// The text form is one exchange (match:resources-requested). The annotation
// form is two, in order: gather the annotation's context first, then hand
// that context to the scored search. The gather is not an optimization —
// match:search-requested REQUIRES a context payload, so skipping it would
// just be a rejected request.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

const matchUsage = `Usage: semiont match --search <text> [options]
       semiont match <resourceId> <annotationId> [options]

Search the knowledge base. Give one of the two forms:

  --search <text>               Resources whose text matches, and when none
                                does, resources that discuss it
  <resourceId> <annotationId>   Resources this annotation could bind to:
                                gathers the annotation's context, then runs
                                a scored search over the KB

Options:
  --entity-type <name>  With --search: only resources of this entity type
  --no-semantic         With an annotation: skip semantic scoring (lexical only)
  --limit <n>           Maximum results (default 20 with --search, 10 with
                        an annotation)
  --json                Raw JSON reply
  --repo <owner/name>   Target a codespace stack (default: the local stack)
  --runtime <rt>        Target the local stack explicitly
  --help                Show this help

Requires a session:  semiont login
`

func Match(args []string) int {
	u := launcher.NewUI(false)
	var positional []string
	var search, entityType, repo string
	limit := 0
	searching, noSemantic, asJSON, wantLocal := false, false, false, false

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
		var ok bool
		switch a {
		case "--limit":
			var v string
			v, ok = val()
			if ok {
				n, err := strconv.Atoi(v)
				if err != nil || n < 1 {
					u.Fail("--limit wants a positive number, got %q", v)
					return 1
				}
				limit = n
			}
		case "--search":
			search, ok = val()
			searching = true
		case "--entity-type":
			entityType, ok = val()
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
				u.Fail("Unknown argument: %s", a)
				return 1
			}
			positional = append(positional, a)
			ok = true
		}
		if !ok {
			return 1
		}
	}
	// The two forms ask different questions of different operations, so an
	// invocation that states both, or neither, has not said which.
	switch {
	case searching && len(positional) > 0:
		u.Fail("--search <text> searches resources by text; <resourceId> <annotationId> searches for what an annotation could bind to. Pick one.")
		return 1
	case searching && search == "":
		u.Fail("--search wants the text to search for.")
		return 1
	case searching && noSemantic:
		u.Fail("--no-semantic only applies to: semiont match <resourceId> <annotationId>")
		return 1
	case !searching && entityType != "":
		u.Fail("--entity-type only applies with --search.")
		return 1
	case !searching && len(positional) != 2:
		u.Fail("match needs --search <text>, or <resourceId> <annotationId> (got %d positional argument(s)).", len(positional))
		fmt.Fprintln(os.Stderr, "  semiont match --help")
		return 1
	}

	t, ok := launcher.VerbSession(u, "match", repo, wantLocal)
	if !ok {
		return 1
	}
	cli := t.Transport()
	ctx := context.Background()

	if searching {
		if limit == 0 {
			limit = 20
		}
		req := semiont.MatchResourcesRequest{Search: search, Limit: &limit}
		if entityType != "" {
			req.EntityType = &entityType
		}
		reply, err := cli.Request(ctx, "match:resources-requested", req, nil)
		if err != nil {
			return busFail(u, "match", err)
		}
		if asJSON {
			fmt.Println(string(reply))
			return 0
		}
		var found semiont.MatchResourcesResult
		if json.Unmarshal(reply, &found) != nil {
			return rawFallback(reply)
		}
		printResources(u, found.Response.Resources, int(found.Response.Total))
		return 0
	}

	resourceID, annotationID := positional[0], positional[1]
	if limit == 0 {
		limit = 10
	}

	// Step 1: the annotation's context (streaming operation).
	u.Log("Gathering context for %s...", annotationID)
	gathered, err := cli.Request(ctx, "gather:requested", semiont.GatherAnnotationRequest{
		ResourceId:   resourceID,
		AnnotationId: annotationID,
	}, nil)
	if err != nil {
		return busFail(u, "match (gather step)", err)
	}
	var gc semiont.GatherAnnotationComplete
	if json.Unmarshal(gathered, &gc) != nil {
		u.Fail("match: the gathered context could not be read.")
		return 1
	}

	// Step 2: the scored search, grounded by that context.
	req := semiont.MatchSearchRequest{
		ResourceId:  resourceID,
		ReferenceId: annotationID,
		Context:     gc.Response,
		Limit:       &limit,
	}
	semantic := !noSemantic
	req.UseSemanticScoring = &semantic
	reply, err := cli.Request(ctx, "match:search-requested", req, nil)
	if err != nil {
		return busFail(u, "match", err)
	}
	if asJSON {
		fmt.Println(string(reply))
		return 0
	}

	// Parsed with the GENERATED type, not a hand-rolled struct: resources
	// are JSON-LD (`@id`, not `id`), and hand-rolling that field name was
	// exactly how this verb shipped printing blank identifiers. The schema
	// owns the shape; Go should read it from there.
	var results semiont.MatchSearchResult
	if json.Unmarshal(reply, &results) != nil {
		return rawFallback(reply)
	}
	rows := results.Response
	if len(rows) == 0 {
		u.Log("No candidates found.")
		return 0
	}
	for _, r := range rows {
		trailer := ""
		if r.Score != nil {
			trailer = fmt.Sprintf("%.3f", *r.Score)
		}
		if r.MatchReason != nil && *r.MatchReason != "" {
			trailer = strings.TrimSpace(trailer + "  " + *r.MatchReason)
		}
		fmt.Printf("  %-28s %-40s %s\n", r.Id, r.Name, u.Dim(trailer))
	}
	fmt.Printf("\n  %s\n", u.Dim(fmt.Sprintf("%d candidate(s) — bind one with: semiont bind %s %s <resourceId>",
		len(rows), resourceID, annotationID)))
	return 0
}
