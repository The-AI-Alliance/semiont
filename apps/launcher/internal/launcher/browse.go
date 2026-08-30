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

With --browser, the act lands on the PARTICIPANT's screen instead of printing
here — the same act, a different audience. Two things can be opened:

  semiont browse <resourceId> --browser              a resource
  semiont browse --annotation <id> --browser         one annotation, opened

The annotation form takes no resourceId: an annotation id names exactly one
annotation on exactly one resource, so the id is the whole address.

Either form needs a web browser watching the Browser; when none is, the
command says so and exits non-zero, so a tour script can stop rather than
narrate to an empty room.

Options:
  --browser             Open it in the Browser instead of printing here
  --annotation <id>     With --browser: open ONE annotation (not --annotations)
  --launch              With --browser: start the Browser if none is running
  --browser-url <url>   Browser origin to report (default: the recorded one)
  --search <text>       Filter the list by text
  --entity-type <name>  Filter the list by entity type
  --limit <n>           Maximum results (default 20)
  --annotations         With a resourceId: show its annotations here
  --entity-types        List the KB's entity-type vocabulary
  --json                Raw JSON reply instead of a table
  --repo <owner/name>   Target a codespace stack (default: the local stack)
  --runtime <rt>        Target the local stack explicitly
  --help                Show this help

Requires a session:  semiont login --email <address>
`

func Browse(args []string) int {
	u := newUI(false)
	var resourceID, search, entityType, repo, browserURL, annotation string
	limit := 20
	annotations, entityTypes, asJSON, wantLocal := false, false, false, false
	toBrowser, launch := false, false

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
		case "--browser":
			toBrowser = true
		case "--annotation":
			v, ok := val()
			if !ok {
				return 1
			}
			annotation = v
		case "--launch":
			launch = true
		case "--browser-url":
			v, ok := val()
			if !ok {
				return 1
			}
			browserURL = v
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
	// --annotation and --annotations are one keystroke apart and mean opposite
	// things: one DRIVES a remote viewer to a single annotation, the other
	// RENDERS a list here. Name the trap — "conflicting flags" is exactly the
	// message a typo needs and does not get.
	if annotation != "" && annotations {
		u.fail("--annotation <id> opens ONE annotation on the participant's screen; --annotations (plural) lists them here. Pick one.")
		return 1
	}
	if annotations && resourceID == "" {
		u.fail("--annotations needs a resourceId: semiont browse <resourceId> --annotations")
		return 1
	}
	// --browser names a DESTINATION; the rendering flags each name a local
	// rendering. Together they state two destinations at once, so say which
	// pair conflicts rather than silently honouring one of them.
	if toBrowser {
		for _, conflict := range []struct {
			set  bool
			flag string
		}{{asJSON, "--json"}, {annotations, "--annotations"}, {entityTypes, "--entity-types"}} {
			if conflict.set {
				u.fail("--browser opens it in the Browser; %s renders it here. Pick one.", conflict.flag)
				return 1
			}
		}
		// An annotation id names exactly one annotation on exactly one
		// resource, so this form carries no resourceId — on the wire OR here.
		// Accepting one the launcher never sends would put the driver back in
		// charge of keeping two ids consistent, which is the redundancy
		// BrowseClickEvent was trimmed of; and since verifying the pair would
		// take a read this verb must not do, an unmatched pair could only be
		// echoed back as a lie.
		if annotation != "" {
			if resourceID != "" {
				u.fail("--annotation %s already names one annotation on one resource; drop the resourceId %q.", annotation, resourceID)
				return 1
			}
		} else if resourceID == "" {
			u.fail("--browser needs a resourceId: semiont browse <resourceId> --browser")
			fmt.Fprintln(os.Stderr, "  (Opening the resource LIST in the Browser is a different route and is not supported yet.)")
			return 1
		}
	}
	// Starting a container is a large action for a READ verb to take, so it
	// stays explicit twice over: --launch opts in, and it is refused outside
	// the one destination it could possibly mean (BROWSER-HANDOFF D4).
	for _, dep := range []struct {
		set  bool
		flag string
	}{{launch, "--launch"}, {browserURL != "", "--browser-url"}, {annotation != "", "--annotation"}} {
		if dep.set && !toBrowser {
			u.fail("%s only applies with --browser.", dep.flag)
			return 1
		}
	}

	t, ok := verbSession(u, "browse", repo, wantLocal)
	if !ok {
		return 1
	}
	cli := newTransport(t.base, t.token)

	// --browser is the one path in this file that SIGNALS instead of reading:
	// a fire-and-forget emit, no correlation id, no reply, nothing rendered
	// locally. It returns here rather than threading a "did we render" flag
	// through the request/reply path below, which stays a pure read.
	if toBrowser {
		d := drive{
			subject: resourceID,
			channel: bus.BrowseResourceOpen,
			payload: semiont.BrowseResourceOpenEvent{ResourceId: resourceID},
			retry:   fmt.Sprintf("semiont browse %s --browser", resourceID),
		}
		if annotation != "" {
			d = drive{
				subject: "annotation " + annotation,
				channel: bus.BrowseClick,
				payload: semiont.BrowseClickEvent{AnnotationId: annotation},
				retry:   fmt.Sprintf("semiont browse --annotation %s --browser", annotation),
			}
		}
		subscribers, err := cli.Emit(context.Background(), d.channel, d.payload, "")
		if err != nil {
			return busFail(u, "browse", err)
		}
		// A count of exactly zero is the one case the launcher can act on: the
		// signal was published and nobody was there. Probe only then — the
		// happy path must not pay for an HTTP round trip it never reads, and
		// -1 ("count unknown") is not evidence of an empty room.
		if subscribers == 0 {
			return nobodySaw(u, d, browserURL, launch)
		}
		u.ok("Opened %s in the Browser %s", d.subject, audienceNote(u, subscribers, string(d.channel)))
		return 0
	}

	// Typed request per operation — the generated types come from the same
	// schemas the gateway validates against, so a wrong or missing field is
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

// drive is one `--browser` act: what was sent, on which channel, and the
// command that would retry it. It exists so the empty-room report below is
// written once — a resource and an annotation fail for identical reasons, and
// a second copy of that three-message branch would drift from this one.
type drive struct {
	subject string // how to name it to a human: "res-42", "annotation ann-9"
	channel bus.Channel
	payload any
	retry   string // the exact command, minus --launch
}

// nobodySaw explains a `--browser` emit that reached zero subscribers, and
// fails the command. Three situations reach here and they want three
// different things said — collapsing them into one "not available" is the
// failure mode this exists to avoid (BROWSER-HANDOFF P2):
//
//	Browser up, nobody watching → the ORIGIN, and "open it and log in"
//	Browser absent              → --launch, or start --service browser
//	Browser there but not answering → say so; the same two fix-its apply
//
// The exit code is the point for a tour script: `beckon` exits 0 with no
// audience because a beckon is genuinely fire-and-forget, but here the caller
// asked for a specific outcome — a resource on a participant's screen — and
// it did not happen. A tour that narrates on to step 2 is worse than one that
// stops.
func nobodySaw(u *ui, d drive, override string, launch bool) int {
	p := browserTarget(loadStackSet(), override)
	if !p.Running && launch {
		next, ok := launchBrowser(u, override)
		if !ok {
			return 1
		}
		p = next
	}

	u.fail("Nobody saw %s — nothing is subscribed to %s.", d.subject, d.channel)
	if p.Running {
		// The Browser CONTAINER is up; what is missing is a human's web
		// browser pointed at it. Those two fail independently — this branch
		// is the proof — so the words stay distinct in every message here.
		fmt.Fprintln(os.Stderr, "  The Browser is running, but no web browser is watching it.")
		fmt.Fprintf(os.Stderr, "  Open %s, log in, then run this again.\n", p.Endpoint)
		return 1
	}
	if p.State == "" {
		fmt.Fprintln(os.Stderr, "  No Browser is running on this machine.")
	} else {
		fmt.Fprintf(os.Stderr, "  The Browser container is %s and is not answering on %s.\n", p.State, p.Endpoint)
	}
	fmt.Fprintf(os.Stderr, "  Start it:  %s --launch\n", d.retry)
	fmt.Fprintln(os.Stderr, "  or:        semiont start --service browser")
	return 1
}

// launchBrowser is `--launch`: it starts the Browser through the existing
// `semiont start --service browser` rather than re-deriving the run. That
// path already pulls the image, publishes the port, records the endpoint and
// WAITS for health (flowBrowser) — on a cold pull the container exists long
// before it answers, and a message printed too early sends the user to an
// origin that refuses the connection.
//
// It starts a CONTAINER. It cannot open a window or log anyone in, so its
// caller still prints the "nobody is watching" message afterwards.
func launchBrowser(u *ui, override string) (browserProbe, bool) {
	// The runtime is named explicitly. A bare start on a machine whose only
	// recorded stacks are codespaces dispatches to the cloud (start.go), and
	// waking a paid VM is not what --launch asked for. The Browser is
	// machine-level — it serves every KB here — so it is always local.
	rt, ok := selectRuntime(u, "")
	if !ok {
		return browserProbe{}, false
	}
	if code := Start([]string{"--service", "browser", "--runtime", rt}); code != 0 {
		u.fail("--launch could not start the Browser.")
		return browserProbe{}, false
	}
	return browserTarget(loadStackSet(), override), true
}

// busFail turns a bus error into the launcher's voice: a rejection carries
// the gateway's own message, a timeout says what went unanswered, and an
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

// rawFallback prints what the gateway actually said. A reply we cannot shape
// is still information — swallowing it would be the dishonest option.
func rawFallback(payload json.RawMessage) int {
	fmt.Println(string(payload))
	return 0
}
