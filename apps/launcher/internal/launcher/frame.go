package launcher

// frame.go — `semiont frame`: writes to the KB's SCHEMA layer. Where every
// other verb acts on content (resources, annotations, references, attention),
// Frame acts on what kinds of things exist. See docs/protocol/flows/FRAME.md.
//
// Reads deliberately live on Browse — `semiont browse --entity-types` is the
// live read of the vocabulary this verb writes to. The asymmetry is the
// protocol's, not this file's.

import (
	"context"
	"fmt"
	"os"
	"strings"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

const frameUsage = `Usage: semiont frame --entity-type <name> [--entity-type <name> ...]

Grow the knowledge base's schema vocabulary — the entity types every other
flow is expressed in (Person, Organization, Concept, ...). Read the current
vocabulary back with:  semiont browse --entity-types

The vocabulary is grow-only, and adding a type that already exists is a
no-op — so re-running this is always safe.

Options:
  --entity-type <name>  Add this entity type (repeatable)
  --repo <owner/name>   Target a codespace stack (default: the local stack)
  --runtime <rt>        Target the local stack explicitly
  --help                Show this help

Requires a session:  semiont login --email <address>
`

func Frame(args []string) int {
	u := newUI(false)
	var entityTypes []string
	var repo string
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
		switch a {
		case "--entity-type":
			v, ok := val()
			if !ok {
				return 1
			}
			if strings.TrimSpace(v) == "" {
				u.fail("--entity-type needs a name.")
				return 1
			}
			entityTypes = append(entityTypes, v)
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
		case "--help", "-h":
			fmt.Print(frameUsage)
			return 0
		default:
			if strings.HasPrefix(a, "-") {
				u.fail("Unknown argument: %s", a)
				return 1
			}
			// Frame owns more than one schema primitive in the protocol
			// (entity types today, tag schemas next), so a bare operand has
			// no unambiguous meaning. Refusing keeps the door open; guessing
			// would nail it shut.
			u.fail("frame takes no bare arguments; say what %q is:  --entity-type %s", a, a)
			return 1
		}
	}
	if len(entityTypes) == 0 {
		fmt.Print(frameUsage)
		return 1
	}

	t, ok := verbSession(u, "frame", repo, wantLocal)
	if !ok {
		return 1
	}
	cli := bus.NewClient(t.base, t.token)

	// One command per type: the protocol has no batch add (the SDK's
	// addEntityTypes is the same loop). A rejection STOPS the run rather
	// than pressing on — a total that counted adds the backend refused
	// would be a lie, and the untried tags cost nothing to re-issue.
	var added []string
	for _, et := range entityTypes {
		_, err := cli.Request(context.Background(), "frame:add-entity-type",
			semiont.FrameAddEntityTypeCommand{Tag: et}, nil)
		if err != nil {
			code := busFail(u, "frame", err)
			if len(added) > 0 {
				fmt.Fprintf(os.Stderr, "  Added before the failure: %s\n", strings.Join(added, ", "))
				fmt.Fprintln(os.Stderr, "  Re-running is safe — adding an existing entity type is a no-op.")
			}
			return code
		}
		added = append(added, et)
	}

	// "Accepted", not "created": the ack carries no payload, so the backend
	// never says whether a type was new or already there.
	u.ok("Entity types accepted: %s %s", strings.Join(added, ", "),
		u.dim("(semiont browse --entity-types shows the vocabulary)"))
	return 0
}
