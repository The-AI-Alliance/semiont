package verbs

// beckon.go — `semiont beckon`: draw a participant's attention to a
// resource or annotation. Fire-and-forget by design: beckon:focus is a
// broadcast launcher.UI signal with no reply channel, so this verb reports what it
// SENT, never that anyone saw it. Claiming delivery would be a lie the
// protocol cannot back up.

import (
	"fmt"
	"strings"

	launcher "github.com/The-AI-Alliance/semiont/packages/go/launcher"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

const beckonIDs = "semiont beckon [options] -- <resourceId> [<annotationId>]"

const beckonUsage = `Usage: semiont beckon --resource <resourceId> [--annotation <id>] [--sparkle]
       semiont beckon <resourceId> [<annotationId>] [--sparkle]

Draw attention to a resource (or one annotation in it) for anyone watching
this KB in a Browser.

Options:
  --resource <id>      The resource to point at (required; bare: first)
  --annotation <id>    Narrow the attention to one annotation (bare: second)
  --sparkle            Mark the annotation WITHOUT scrolling to it
                       (requires --annotation)
  --repo <owner/name>  Target a codespace stack
  --root <path>        Target the stack of the knowledge base at path
  --runtime <rt>       Target a stack here
  --help               Show this help

` + idsOrder + `

` + idsNote + `
  ` + beckonIDs + `

Requires a session:  semiont login

This is a broadcast signal: it has no reply, so the command can confirm only
that the signal was sent — not that a participant is watching.
`

// audienceNote renders what the gateway's subscriber count licenses this verb
// to say, and nothing more. The three cases are genuinely different answers:
//
//	uncounted  the gateway accepted the emit and gave no count: it cannot
//	           count, or answered with a body we could not read. We know it
//	           was accepted and know nothing about reach — so we claim
//	           nothing.
//	n == 0     nobody was subscribed — the signal reached an empty room. Said
//	           plainly, because a ✓ over this is the silent failure the whole
//	           subscriber count exists to end.
//	n > 0      n connections were listening at dispatch. Still not delivery:
//	           a subscriber is a connection, not a pair of eyes, and beckon
//	           is a broadcast with no reply channel.
//
// The exit code is 0 in all three: beckon is fire-and-forget by contract, and
// an empty room is a fact, not a failure.
func audienceNote(u *launcher.UI, subscribers int, counted bool, channel string) string {
	switch {
	case !counted:
		return u.Dim("(broadcast — no delivery confirmation)")
	case subscribers == 0:
		return u.Wrap(launcher.AnsiYellow, "— nothing is subscribed to "+channel+", so no one received it")
	case subscribers == 1:
		return u.Dim("(1 subscriber — broadcast, so still no confirmation anyone looked)")
	default:
		return u.Dim(fmt.Sprintf("(%d subscribers — broadcast, so still no confirmation anyone looked)", subscribers))
	}
}

func Beckon(args []string) int {
	u := launcher.NewUI(false)
	var resource, annotation, repo string
	var positional []string
	wantLocal := false
	rootFlag := ""
	sparkle := false

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
		var ok bool
		switch a {
		case "--resource":
			ok = idValue(u, "resource", val, &resource)
		case "--annotation":
			ok = idValue(u, "annotation", val, &annotation)
		case "--repo":
			repo, ok = val()
		case "--sparkle":
			sparkle, ok = true, true
		case "--root":
			rootFlag, ok = val()
		case "--runtime":
			_, ok = val()
			wantLocal = true
		case "--":
			// Every word after it is an id, whatever it begins with.
			positional = append(positional, args[i+1:]...)
			break options
		case "--help", "-h":
			fmt.Print(beckonUsage)
			return 0
		default:
			if strings.HasPrefix(a, "-") {
				return unknownArgument(u, a, beckonIDs)
			}
			positional, ok = append(positional, a), true
		}
		if !ok {
			return 1
		}
	}
	if !fillIDs(u, beckonIDs, positional, &resource, &annotation) {
		return 1
	}
	if resource == "" {
		fmt.Print(beckonUsage)
		return 1
	}
	// BeckonSparkleEvent requires an annotationId — there is no resource-wide
	// sparkle to fall back to, so this refuses rather than inventing one.
	if sparkle && annotation == "" {
		u.Fail("--sparkle marks one annotation, so it needs --annotation <id>")
		return 1
	}
	rid, ok := parsed(u, "resource", resource, api.ParseResourceId)
	if !ok {
		return 1
	}
	var aid *api.AnnotationId
	if annotation != "" {
		named, ok := parsed(u, "annotation", annotation, api.ParseAnnotationId)
		if !ok {
			return 1
		}
		aid = &named
	}

	sess, ok := launcher.VerbSession(u, "beckon", repo, rootFlag, wantLocal)
	if !ok {
		return 1
	}
	defer sess.Close()
	c := sess.Client()

	// Two signals, one act. Focus SCROLLS, so beckoning three references in a
	// row scroll-fights and only the last survives; sparkle is inert-but-visible,
	// which is what makes it the branch menu — light up three and let the
	// participant choose. They are mutually exclusive by construction: this
	// emits one channel, never both.
	channel := bus.BeckonFocus.Channel()
	var subscribers int
	var counted bool
	var err error
	switch {
	case sparkle:
		channel = bus.BeckonSparkle.Channel()
		subscribers, counted, err = c.Beckon.SparkleAll(c.Context(), *aid)
	default:
		subscribers, counted, err = c.Beckon.Attention(c.Context(), rid, aid)
	}
	if err != nil {
		return busFail(u, "beckon", c.Refusal(err))
	}

	target := resource
	if annotation != "" {
		target = fmt.Sprintf("%s (%s)", resource, annotation)
	}
	verb := "Beckoned toward"
	if sparkle {
		verb = "Sparkled"
	}
	u.Ok("%s %s %s", verb, target, audienceNote(u, subscribers, counted, string(channel)))
	return 0
}
