package launcher

// beckon.go — `semiont beckon`: draw a collaborator's attention to a
// resource or annotation. Fire-and-forget by design: beckon:focus is a
// broadcast UI signal with no reply channel, so this verb reports what it
// SENT, never that anyone saw it. Claiming delivery would be a lie the
// protocol cannot back up.

import (
	"context"
	"fmt"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

const beckonUsage = `Usage: semiont beckon --resource <resourceId> [--annotation <id>] [--message <text>]

Draw attention to a resource (or one annotation in it) for anyone watching
this KB in a Browser.

Options:
  --resource <id>      The resource to point at (required)
  --annotation <id>    Narrow the attention to one annotation
  --message <text>     A note to show alongside
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly
  --help               Show this help

Requires a session:  semiont login --email <address>

This is a broadcast signal: it has no reply, so the command can confirm only
that the signal was sent — not that a participant is watching.
`

func Beckon(args []string) int {
	u := newUI(false)
	var resource, annotation, message, repo string
	wantLocal := false

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
		case "--resource":
			resource, ok = val()
		case "--annotation":
			annotation, ok = val()
		case "--message":
			message, ok = val()
		case "--repo":
			repo, ok = val()
		case "--runtime":
			_, ok = val()
			wantLocal = true
		case "--help", "-h":
			fmt.Print(beckonUsage)
			return 0
		default:
			if strings.HasPrefix(a, "-") {
				u.fail("Unknown argument: %s", a)
				return 1
			}
			// A bare id is the resource, matching how people type it.
			if resource != "" {
				u.fail("Unexpected argument: %s", a)
				return 1
			}
			resource, ok = a, true
		}
		if !ok {
			return 1
		}
	}
	if resource == "" {
		fmt.Print(beckonUsage)
		return 1
	}

	t, ok := verbSession(u, "beckon", repo, wantLocal)
	if !ok {
		return 1
	}
	cli := bus.NewClient(t.base, t.token)

	payload := map[string]any{"resourceId": resource}
	if annotation != "" {
		payload["annotationId"] = annotation
	}
	if message != "" {
		payload["message"] = message
	}
	if err := cli.Emit(context.Background(), "beckon:focus", payload, ""); err != nil {
		return busFail(u, "beckon", err)
	}

	target := resource
	if annotation != "" {
		target = fmt.Sprintf("%s (%s)", resource, annotation)
	}
	u.ok("Beckoned toward %s %s", target, u.dim("(broadcast — no delivery confirmation)"))
	return 0
}
