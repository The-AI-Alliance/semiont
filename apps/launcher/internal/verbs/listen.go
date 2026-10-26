package verbs

// listen.go — `semiont listen`: subscribe to the KB's live event stream and
// print events until interrupted. The pure-streaming verb: no reply to wait
// for, just the bus. Only BRIDGED channels can be subscribed to over a
// transport, so the default set is the bridged broadcasts — asking for an
// unbridged channel would hang forever with no error, which is exactly the
// silent-failure trap the bus docs warn about. A resource's scope carries its
// own channels (bus.ResourceScopedChannels), and nothing else.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"slices"
	"syscall"
	"time"

	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

const listenUsage = `Usage: semiont listen [--channel <name>]... [options]

Subscribe to the knowledge base's live event stream and print events as they
arrive. Runs until interrupted (Ctrl-C).

Options:
  --channel <name>     Subscribe to this channel (repeatable; default: the
                       system-wide broadcasts, or with --scope, every channel
                       a resource's scope carries)
  --scope <resourceId> Subscribe to one resource's scoped channels
  --json               Print each event as raw JSON
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly
  --help               Show this help

Requires a session:  semiont login

Only channels the transport bridges can be received. A channel that exists
but is not bridged will deliver nothing at all, so this warns before
subscribing rather than leaving you watching a stream that can never
produce an event.
`

// Name prefetch bounds. One request, small and quick: this is cosmetics, and
// a console that stalled on startup to pretty-print ids would be worse than
// one that prints ids. Over the limit, later resources render as ids.
const (
	prefetchLimit   = 200
	prefetchTimeout = 3 * time.Second
)

// The default subscription is the GENERATED broadcast set
// (packages/sdk-go/bus/bridged_gen.go, from specs/src/bus/registry.json) —
// the same list the TypeScript side derives. A hand-copied list here would be
// precisely the drift the registry exists to prevent.

func Listen(args []string) int {
	u := launcher.NewUI(false)
	var channels []bus.Channel
	var scope, repo string
	asJSON, wantLocal := false, false

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
		case "--channel":
			var v string
			v, ok = val()
			if ok {
				channels = append(channels, bus.Channel(v))
			}
		case "--scope":
			scope, ok = val()
		case "--repo":
			repo, ok = val()
		case "--runtime":
			_, ok = val()
			wantLocal = true
		case "--json":
			asJSON, ok = true, true
		case "--help", "-h":
			fmt.Print(listenUsage)
			return 0
		default:
			u.Fail("Unknown argument: %s", a)
			return 1
		}
		if !ok {
			return 1
		}
	}
	var rid api.ResourceId
	switch {
	case scope != "":
		var ok bool
		if rid, ok = parsed(u, "scope", scope, api.ParseResourceId); !ok {
			return 1
		}
		if len(channels) == 0 {
			channels = bus.ResourceScopedChannels
		}
	case len(channels) == 0:
		channels = bus.BridgedBroadcasts
	}
	// A channel nothing delivers stays silent — say so rather than sitting
	// there pretending to listen.
	for _, ch := range channels {
		switch {
		case scope != "" && !slices.Contains(bus.ResourceScopedChannels, ch):
			u.Warn("%s is not a channel a resource's scope carries — it will deliver nothing.", ch)
		case scope == "" && !bus.Bridged(ch):
			u.Warn("%s is not a bridged channel — it will deliver nothing.", ch)
		}
	}

	sess, ok := launcher.VerbSession(u, "listen", repo, wantLocal)
	if !ok {
		return 1
	}
	defer sess.Close()
	// The stream names the channels globally; a scope's arrive on the scope.
	var global []bus.Channel
	if scope == "" {
		global = channels
	}
	c := sess.Client(global...)
	defer c.Close()
	if scope != "" {
		release := c.Transport.SubscribeToResource(rid)
		defer release()
	}
	var heard []bus.Channel
	for _, ch := range channels {
		if scope == "" || slices.Contains(bus.ResourceScopedChannels, ch) {
			heard = append(heard, ch)
		}
	}
	frames, stopFrames, err := arrivals(c.Transport, heard)
	if err != nil {
		return busFail(u, "listen", err)
	}
	defer stopFrames()

	ctx, stop := signal.NotifyContext(c.Context(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	down := dropped(ctx, c.Transport)

	// Listening is said once the stream is held, never before.
	if err := c.Reached(); err != nil {
		return busFail(u, "listen", err)
	}
	// Resource names, asked ONCE, on the stream the events arrive on. Not per
	// event: one request up front, then never again; ids the prefetch misses
	// render as ids. Events that arrive meanwhile wait for it.
	render := newListenRenderer(prefetchResourceNames(c))

	opened := false
	for state := range c.Transport.StateChanges(ctx) {
		if state == semiont.ConnectionStateOpen {
			opened = true
			break
		}
	}
	if !opened {
		return listenStopped(u, c)
	}

	where := "this KB"
	if scope != "" {
		where = "resource " + scope
	}
	u.Log("Listening to %s %s", where, u.Dim("(Ctrl-C to stop)"))
	// INBOUND ONLY. The guide's own cues (`browse --browser`, `beckon`) are not
	// echoed back on this stream, and silence where a cue should appear must not
	// read as "the cue never arrived" — so say it once, up front, rather than
	// letting the absence speak.
	if !asJSON {
		u.Log("%s", u.Dim("Shows events RECEIVED from this KB — your own beckon/browse cues are not echoed here."))
	}

	for {
		select {
		case <-ctx.Done():
			return listenStopped(u, c)
		case <-down:
			// The stream ended on its own — say so rather than exiting 0 as
			// though the user had asked to stop.
			u.Warn("The event stream closed.")
			return 1
		case frame := <-frames:
			printEvent(u, render, frame, asJSON)
		}
	}
}

// listenStopped ends a `listen` that was stopped: by the user, or by the
// gateway refusing the session for good.
func listenStopped(u *launcher.UI, c *launcher.VerbClient) int {
	if c.Context().Err() != nil {
		return busFail(u, "listen", context.Cause(c.Context()))
	}
	fmt.Println()
	u.Log("Stopped.")
	return 0
}

// prefetchResourceNames builds the resourceId → name map the human rendering
// uses. Best effort by design: a KB that cannot answer, or answers partially,
// costs the console nothing — every id still renders as an id. Failing the
// whole `listen` because a cosmetic lookup failed would be the wrong trade.
func prefetchResourceNames(c *launcher.VerbClient) map[string]string {
	names := map[string]string{}
	ctx, cancel := context.WithTimeout(c.Context(), prefetchTimeout)
	defer cancel()
	page, err := c.Browse.Resources(semiont.ResourceFilters{Limit: prefetchLimit}).Fresh(ctx)
	if err != nil {
		return names
	}
	for _, res := range page.Resources {
		names[res.Id.String()] = res.Name
	}
	return names
}

func printEvent(u *launcher.UI, render *listenRenderer, frame semiont.Frame, asJSON bool) {
	if asJSON {
		// UNCHANGED, deliberately: scripts parse this. The human rendering must
		// never leak into the machine one.
		b, _ := json.Marshal(map[string]any{"channel": frame.Channel, "payload": frame.Payload, "scope": frame.Scope.String()})
		fmt.Println(string(b))
		return
	}
	fmt.Println(render.line(u, frame))
}
