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

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

const beckonUsage = `Usage: semiont beckon --resource <resourceId> [--annotation <id>] [--sparkle]

Draw attention to a resource (or one annotation in it) for anyone watching
this KB in a Browser.

Options:
  --resource <id>      The resource to point at (required)
  --annotation <id>    Narrow the attention to one annotation
  --sparkle            Mark the annotation WITHOUT scrolling to it
                       (requires --annotation)
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly
  --help               Show this help

Requires a session:  semiont login --email <address>

This is a broadcast signal: it has no reply, so the command can confirm only
that the signal was sent — not that a participant is watching.
`

// audienceNote renders what the backend's subscriber count licenses this verb
// to say, and nothing more. The three cases are genuinely different answers:
//
//	n == 0   nobody was subscribed — the signal reached an empty room. Said
//	         plainly, because a ✓ over this is the silent failure the whole
//	         subscriber count exists to end.
//	n < 0    the backend answered 2xx with a body we could not read (an older
//	         backend). We know it was accepted and know nothing about reach —
//	         so we claim nothing, which is what this verb used to always do.
//	n > 0    n connections were listening at dispatch. Still not delivery: a
//	         subscriber is a connection, not a pair of eyes, and beckon is a
//	         broadcast with no reply channel.
//
// The exit code is 0 in all three: beckon is fire-and-forget by contract, and
// an empty room is a fact, not a failure.
func audienceNote(u *ui, subscribers int, channel string) string {
	switch {
	case subscribers == 0:
		return u.wrap(ansiYellow, "— nothing is subscribed to "+channel+", so no one received it")
	case subscribers < 0:
		return u.dim("(broadcast — no delivery confirmation)")
	case subscribers == 1:
		return u.dim("(1 subscriber — broadcast, so still no confirmation anyone looked)")
	default:
		return u.dim(fmt.Sprintf("(%d subscribers — broadcast, so still no confirmation anyone looked)", subscribers))
	}
}

func Beckon(args []string) int {
	u := newUI(false)
	var resource, annotation, repo string
	wantLocal := false
	sparkle := false

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
		case "--repo":
			repo, ok = val()
		case "--sparkle":
			sparkle, ok = true, true
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
	// BeckonSparkleEvent requires an annotationId — there is no resource-wide
	// sparkle to fall back to, so this refuses rather than inventing one.
	if sparkle && annotation == "" {
		u.fail("--sparkle marks one annotation, so it needs --annotation <id>")
		return 1
	}

	t, ok := verbSession(u, "beckon", repo, wantLocal)
	if !ok {
		return 1
	}
	cli := bus.NewClient(t.base, t.token)

	// Two signals, one act (GUIDED-TOUR P6). Focus SCROLLS, so beckoning three
	// references in a row scroll-fights and only the last survives; sparkle is
	// inert-but-visible, which is what makes it the branch menu — light up three
	// and let the participant choose. They are mutually exclusive by
	// construction: this emits one channel, never both.
	channel := bus.Channel("beckon:focus")
	var payload any
	if sparkle {
		channel = bus.Channel("beckon:sparkle")
		payload = semiont.BeckonSparkleEvent{AnnotationId: annotation}
	} else {
		// BeckonFocusEvent carries a resource and an annotation — and nothing
		// else. An earlier version sent a `message` field the schema does not
		// declare; the flag is gone rather than quietly dropped on the wire.
		ev := semiont.BeckonFocusEvent{ResourceId: &resource}
		if annotation != "" {
			ev.AnnotationId = &annotation
		}
		payload = ev
	}

	subscribers, err := cli.Emit(context.Background(), channel, payload, "")
	if err != nil {
		return busFail(u, "beckon", err)
	}

	target := resource
	if annotation != "" {
		target = fmt.Sprintf("%s (%s)", resource, annotation)
	}
	verb := "Beckoned toward"
	if sparkle {
		verb = "Sparkled"
	}
	u.ok("%s %s %s", verb, target, audienceNote(u, subscribers, string(channel)))
	return 0
}
