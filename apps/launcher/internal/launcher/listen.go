package launcher

// listen.go — `semiont listen`: subscribe to the KB's live event stream and
// print events until interrupted. The pure-streaming verb: no request, no
// reply, just the bus. Only BRIDGED channels can be subscribed to over a
// transport, so the default set is the bridged broadcasts — asking for an
// unbridged channel would hang forever with no error, which is exactly the
// silent-failure trap the bus docs warn about.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

const listenUsage = `Usage: semiont listen [--channel <name>]... [options]

Subscribe to the knowledge base's live event stream and print events as they
arrive. Runs until interrupted (Ctrl-C).

Options:
  --channel <name>     Subscribe to this channel (repeatable; default: the
                       system-wide broadcasts)
  --scope <resourceId> Subscribe to one resource's scoped channels
  --json               Print each event as raw JSON
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly
  --help               Show this help

Requires a session:  semiont login --email <address>

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
// the same list the TypeScript side derives. It used to be hand-copied here,
// which is precisely the drift the registry exists to prevent.

func Listen(args []string) int {
	u := newUI(false)
	var channels []bus.Channel
	var scope, repo string
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
			u.fail("Unknown argument: %s", a)
			return 1
		}
		if !ok {
			return 1
		}
	}
	if len(channels) == 0 {
		channels = bus.BridgedBroadcasts
	}
	// A channel nobody bridges delivers nothing, silently — say so rather
	// than sitting there pretending to listen.
	for _, ch := range channels {
		if !bus.Bridged(ch) {
			u.warn("%s is not a bridged channel — it will deliver nothing.", ch)
		}
	}

	t, ok := verbSession(u, "listen", repo, wantLocal)
	if !ok {
		return 1
	}
	cli := newTransport(t.base, t.token)

	// Resource names, fetched ONCE before the stream opens. Not per event: a
	// lookup is a correlated Request, which opens its own SSE connection, and
	// since presence landed (P7) every connection publishes session:joined/left
	// — so inline resolution would make this console generate the churn it is
	// meant to report. One request up front, then never again; ids the prefetch
	// misses render as ids.
	render := newListenRenderer(prefetchResourceNames(cli))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var scoped []bus.Channel
	if scope != "" {
		scoped, channels = channels, nil
	}
	sub, err := cli.Subscribe(ctx, channels, scoped, scope)
	if err != nil {
		return busFail(u, "listen", err)
	}
	defer sub.Close()

	where := "this KB"
	if scope != "" {
		where = "resource " + scope
	}
	u.log("Listening to %s %s", where, u.dim("(Ctrl-C to stop)"))
	// INBOUND ONLY. The guide's own cues (`browse --browser`, `beckon`) are not
	// echoed back on this stream, and silence where a cue should appear must not
	// read as "the cue never landed" — so say it once, up front, rather than
	// letting the absence speak.
	if !asJSON {
		u.log("%s", u.dim("Shows events RECEIVED from this KB — your own beckon/browse cues are not echoed here."))
	}

	for {
		select {
		case <-ctx.Done():
			fmt.Println()
			u.log("Stopped.")
			return 0
		case ev, open := <-sub.Events:
			if !open {
				// The stream ended on its own — say so rather than exiting 0
				// as though the user had asked to stop.
				if err := sub.Err(); err != nil {
					u.fail("The event stream ended: %v", err)
					return 1
				}
				u.warn("The event stream closed.")
				return 1
			}
			printEvent(u, render, ev, asJSON)
		}
	}
}

// prefetchResourceNames builds the resourceId → name map the human rendering
// uses. Best effort by design: a KB that cannot answer, or answers partially,
// costs the console nothing — every id still renders as an id. Failing the
// whole `listen` because a cosmetic lookup failed would be the wrong trade.
func prefetchResourceNames(cli bus.Transport) map[string]string {
	names := map[string]string{}
	ctx, cancel := context.WithTimeout(context.Background(), prefetchTimeout)
	defer cancel()
	limit := prefetchLimit
	req := semiont.BrowseResourcesRequest{}
	req.Limit = &limit
	reply, err := cli.Request(ctx, "browse:resources-requested", req, &bus.RequestOptions{Timeout: prefetchTimeout})
	if err != nil {
		return names
	}
	var r semiont.BrowseResourcesResult
	if json.Unmarshal(reply, &r) != nil {
		return names
	}
	for _, res := range r.Response.Resources {
		names[res.Id] = res.Name
	}
	return names
}

func printEvent(u *ui, render *listenRenderer, ev bus.Event, asJSON bool) {
	if asJSON {
		// UNCHANGED, deliberately: scripts parse this. The human rendering must
		// never leak into the machine one.
		b, _ := json.Marshal(map[string]any{"channel": ev.Channel, "payload": json.RawMessage(ev.Payload), "scope": ev.Scope})
		fmt.Println(string(b))
		return
	}
	fmt.Println(render.line(u, ev))
}
