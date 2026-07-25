package launcher

// bind.go — `semiont bind`: resolve a linking annotation to a target
// resource by adding a SpecificResource body item (purpose: linking). One
// bus operation, bind:update-body, whose payload is a list of body
// operations — so unbinding is the same call with op "remove".

import (
	"context"
	"fmt"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

const bindUsage = `Usage: semiont bind <resourceId> <annotationId> <targetResourceId>
       semiont bind <resourceId> <annotationId> --unbind <targetResourceId>

Point a linking annotation at the resource it refers to.

Options:
  --unbind <id>        Remove that target instead of adding it
  --json               Raw JSON reply
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly
  --help               Show this help

Requires a session:  semiont login --email <address>
`

func Bind(args []string) int {
	u := newUI(false)
	var positional []string
	var unbind, repo string
	asJSON, wantLocal := false, false

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
		case "--unbind":
			unbind, ok = val()
		case "--repo":
			repo, ok = val()
		case "--runtime":
			_, ok = val()
			wantLocal = true
		case "--json":
			asJSON, ok = true, true
		case "--help", "-h":
			fmt.Print(bindUsage)
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

	want := 3
	if unbind != "" {
		want = 2
	}
	if len(positional) != want {
		fmt.Print(bindUsage)
		return 1
	}
	resourceID, annotationID := positional[0], positional[1]
	target := unbind
	op := "add"
	if unbind == "" {
		target = positional[2]
	} else {
		op = "remove"
	}

	t, ok := verbSession(u, "bind", repo, wantLocal)
	if !ok {
		return 1
	}
	cli := bus.NewClient(t.base, t.token)

	reply, err := cli.Request(context.Background(), "bind:update-body", map[string]any{
		"resourceId":   resourceID,
		"annotationId": annotationID,
		"operations": []map[string]any{{
			"op":   op,
			"item": map[string]any{"type": "SpecificResource", "source": target, "purpose": "linking"},
		}},
	}, nil)
	if err != nil {
		return busFail(u, "bind", err)
	}
	if asJSON {
		fmt.Println(string(reply))
		return 0
	}
	if unbind != "" {
		u.ok("Unbound %s from %s", annotationID, target)
	} else {
		u.ok("Bound %s → %s", annotationID, target)
	}
	return 0
}
