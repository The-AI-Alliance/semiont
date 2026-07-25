package launcher

// browse.go — `semiont browse`: reads over the event bus (the launcher's
// first bus verb). Every read is one correlated request/reply exchange
// through packages/sdk-go/bus; the operation names and payload schemas come
// from specs/src/bus/registry.json, so this file holds no protocol knowledge
// of its own beyond which operation answers which question.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

const browseUsage = `Usage: semiont browse [<resourceId>] [options]

Read the knowledge base. With no resourceId, lists resources; with one,
shows that resource (add --annotations for its annotations).

Options:
  --search <text>       Filter the list by text
  --entity-type <name>  Filter the list by entity type
  --limit <n>           Maximum results (default 20)
  --annotations         With a resourceId: show its annotations instead
  --entity-types        List the KB's entity-type vocabulary
  --json                Raw JSON reply instead of a table
  --repo <owner/name>   Target a codespace stack (default: the local stack)
  --runtime <rt>        Target the local stack explicitly
  --help                Show this help

Requires a session:  semiont login --email <address>
`

func Browse(args []string) int {
	u := newUI(false)
	var resourceID, search, entityType, repo string
	limit := 20
	annotations, entityTypes, asJSON, wantLocal := false, false, false, false

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
		switch a {
		case "--search":
			v, ok := val()
			if !ok {
				return 1
			}
			search = v
		case "--entity-type":
			v, ok := val()
			if !ok {
				return 1
			}
			entityType = v
		case "--limit":
			v, ok := val()
			if !ok {
				return 1
			}
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 {
				u.fail("--limit wants a positive number, got %q", v)
				return 1
			}
			limit = n
		case "--repo":
			v, ok := val()
			if !ok {
				return 1
			}
			repo = v
		case "--runtime":
			if _, ok := val(); !ok {
				return 1
			}
			wantLocal = true
		case "--annotations":
			annotations = true
		case "--entity-types":
			entityTypes = true
		case "--json":
			asJSON = true
		case "--help", "-h":
			fmt.Print(browseUsage)
			return 0
		default:
			if strings.HasPrefix(a, "-") {
				u.fail("Unknown argument: %s", a)
				return 1
			}
			if resourceID != "" {
				u.fail("Only one resourceId may be given (got %q and %q).", resourceID, a)
				return 1
			}
			resourceID = a
		}
	}
	if annotations && resourceID == "" {
		u.fail("--annotations needs a resourceId: semiont browse <resourceId> --annotations")
		return 1
	}

	t, ok := verbSession(u, "browse", repo, wantLocal)
	if !ok {
		return 1
	}
	cli := bus.NewClient(t.base, t.token)

	// Typed request per operation — the generated types come from the same
	// schemas the backend validates against, so a wrong or missing field is
	// a compile error here rather than a rejection (or a silent drop) there.
	var op bus.Channel
	var payload any
	switch {
	case entityTypes:
		op = "browse:entity-types-requested"
		payload = semiont.BrowseEntityTypesRequest{}
	case annotations:
		op = "browse:annotations-requested"
		payload = semiont.BrowseAnnotationsRequest{ResourceId: resourceID}
	case resourceID != "":
		op = "browse:resource-requested"
		payload = semiont.BrowseResourceRequest{ResourceId: resourceID}
	default:
		op = "browse:resources-requested"
		req := semiont.BrowseResourcesRequest{}
		req.Limit = &limit
		if search != "" {
			req.Search = &search
		}
		if entityType != "" {
			req.EntityType = &entityType
		}
		payload = req
	}

	reply, err := cli.Request(context.Background(), op, payload, nil)
	if err != nil {
		return busFail(u, "browse", err)
	}
	if asJSON {
		fmt.Println(string(reply))
		return 0
	}
	return renderBrowse(u, op, reply)
}

// busFail turns a bus error into the launcher's voice: a rejection carries
// the backend's own message, a timeout says what went unanswered, and an
// expired session points at login rather than leaving the user guessing.
func busFail(u *ui, verb string, err error) int {
	var re *bus.RequestError
	switch {
	case asBusRequestError(err, &re):
		u.fail("%s was rejected: %s", verb, re.Error())
	case strings.Contains(err.Error(), "HTTP 401"):
		u.fail("%s: the session was rejected.", verb)
		fmt.Fprintln(os.Stderr, "  Log in again:  semiont login --email <address>")
	default:
		u.fail("%s failed: %v", verb, err)
	}
	return 1
}

func asBusRequestError(err error, target **bus.RequestError) bool {
	re, ok := err.(*bus.RequestError)
	if ok {
		*target = re
	}
	return ok
}

// renderBrowse prints the human table from the GENERATED reply type for each
// operation. Nothing here parses a field name by hand — that habit shipped a
// verb that printed blank identifiers because resources are JSON-LD (`@id`).
func renderBrowse(u *ui, op bus.Channel, reply json.RawMessage) int {
	switch op {
	case "browse:resources-requested":
		var r semiont.BrowseResourcesResult
		if err := json.Unmarshal(reply, &r); err != nil {
			return rawFallback(reply)
		}
		if len(r.Response.Resources) == 0 {
			u.log("No resources match.")
			return 0
		}
		for _, res := range r.Response.Resources {
			types := ""
			if res.EntityTypes != nil && len(*res.EntityTypes) > 0 {
				types = u.dim("(" + strings.Join(*res.EntityTypes, ", ") + ")")
			}
			fmt.Printf("  %-28s %s %s\n", res.Id, res.Name, types)
		}
		fmt.Printf("\n  %s\n", u.dim(fmt.Sprintf("%d shown, %d total", len(r.Response.Resources), int(r.Response.Total))))
	case "browse:resource-requested":
		var r semiont.BrowseResourceResult
		if err := json.Unmarshal(reply, &r); err != nil {
			return rawFallback(reply)
		}
		fmt.Printf("  %s  %s\n", u.bold(r.Response.Resource.Name), u.dim(r.Response.Resource.Id))
		if r.Response.Resource.EntityTypes != nil && len(*r.Response.Resource.EntityTypes) > 0 {
			fmt.Printf("  %s\n", u.dim("entity types: "+strings.Join(*r.Response.Resource.EntityTypes, ", ")))
		}
		fmt.Printf("  %s\n", u.dim(fmt.Sprintf("%d annotation(s)", len(r.Response.Annotations))))
	case "browse:annotations-requested":
		var r semiont.BrowseAnnotationsResult
		if err := json.Unmarshal(reply, &r); err != nil {
			return rawFallback(reply)
		}
		if len(r.Response.Annotations) == 0 {
			u.log("No annotations on that resource.")
			return 0
		}
		for _, a := range r.Response.Annotations {
			fmt.Printf("  %-28s %s\n", a.Id, u.dim(string(a.Motivation)))
		}
		fmt.Printf("\n  %s\n", u.dim(fmt.Sprintf("%d of %d", len(r.Response.Annotations), int(r.Response.Total))))
	case "browse:entity-types-requested":
		var r semiont.BrowseEntityTypesResult
		if err := json.Unmarshal(reply, &r); err != nil {
			return rawFallback(reply)
		}
		if len(r.Response.EntityTypes) == 0 {
			u.log("This KB declares no entity types yet.")
			return 0
		}
		for _, e := range r.Response.EntityTypes {
			fmt.Printf("  %s\n", e)
		}
	default:
		return rawFallback(reply)
	}
	return 0
}

// rawFallback prints what the backend actually said. A reply we cannot shape
// is still information — swallowing it would be the dishonest option.
func rawFallback(payload json.RawMessage) int {
	fmt.Println(string(payload))
	return 0
}
