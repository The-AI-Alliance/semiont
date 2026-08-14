package launcher

// listen_render.go — the human half of `semiont listen` (GUIDED-TOUR P9).
//
// `listen` began as a debug tap: one line per event, whatever identifier the
// payload happened to carry. That is enough to follow a job and not enough to
// read a room. A tour guide watches this stream to decide whether the
// participant is engaging, which makes the rendering a deliverable rather than
// a diagnostic.
//
// Three things a guide needs that the raw stream does not give:
//
//   - NAMES, not ids. `browse:resource-viewed` carries a resourceId; the guide
//     knows their tour by title. Names are prefetched ONCE at startup (see
//     prefetchResourceNames) rather than resolved per event: a per-event lookup
//     is a correlated bus Request, which opens its own SSE connection — and
//     since P7, every SSE connection publishes session:joined/left. Resolving
//     names inline would make the console generate the very presence churn it
//     is trying to report.
//   - PRESENCE as state. session:joined/left are events; "who is here now" is
//     a number. Kept by connectionId, never by participant: one person with two
//     tabs is two connections, and a map keyed on the DID would report one
//     viewer for two and none when the duplicate closed.
//   - HONESTY about what is missing. The stream is inbound only — the guide's
//     own cues are not echoed back — so the header says so rather than letting
//     silence read as "the cue never landed".
//
// `--json` is deliberately untouched by all of this: scripts parse it, and a
// human rendering that leaked into the machine one would break them.

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

type listenRenderer struct {
	names   map[string]string // resourceId → name, prefetched once
	present map[string]string // connectionId → participant DID
}

func newListenRenderer(names map[string]string) *listenRenderer {
	if names == nil {
		names = map[string]string{}
	}
	return &listenRenderer{names: names, present: map[string]string{}}
}

// watching reports how many live connections the stream has seen open and not
// close. It counts CONNECTIONS, which is what presence measures — see the type
// comment on why that is not the same as counting people.
func (r *listenRenderer) watching() int { return len(r.present) }

// resourceLabel prefers the name and falls back to the id. It never returns
// empty and never blocks: an id the prefetch missed is still actionable, and a
// blank line is not.
func (r *listenRenderer) resourceLabel(id string) string {
	if id == "" {
		return ""
	}
	if name, ok := r.names[id]; ok && name != "" {
		return fmt.Sprintf("%q", name)
	}
	return id
}

// shortParticipant renders a DID as the part a human recognizes:
// did:web:host:users:alice%40example.com → alice@example.com, and an agent's
// did:web:host:agents:ollama:gemma4 → ollama:gemma4. Anything that is not a
// DID passes through unchanged rather than being mangled into a guess.
func shortParticipant(did string) string {
	if did == "" {
		return "(unknown)"
	}
	for _, seg := range []string{":users:", ":agents:"} {
		if i := strings.Index(did, seg); i >= 0 {
			tail := did[i+len(seg):]
			if decoded, err := url.QueryUnescape(tail); err == nil {
				return decoded
			}
			return tail
		}
	}
	return did
}

// line renders ONE event for a human and folds it into the renderer's state.
// Returns the text to print; callers print it verbatim.
func (r *listenRenderer) line(u *ui, ev bus.Event) string {
	var p struct {
		ResourceID   string `json:"resourceId"`
		AnnotationID string `json:"annotationId"`
		JobID        string `json:"jobId"`
		Message      string `json:"message"`
		Name         string `json:"name"`
		Participant  string `json:"participant"`
		ConnectionID string `json:"connectionId"`
	}
	_ = json.Unmarshal(ev.Payload, &p)
	stamp := u.dim(time.Now().Format("15:04:05"))

	// Presence gets its own shape: the event is the transition, the number is
	// the state, and both belong on the line.
	switch ev.Channel {
	case bus.SessionJoined, bus.SessionLeft:
		who := shortParticipant(p.Participant)
		verb, mark := "joined", u.wrap(ansiGreen, "●")
		if ev.Channel == bus.SessionLeft {
			verb, mark = "left", u.dim("○")
			delete(r.present, p.ConnectionID)
		} else {
			r.present[p.ConnectionID] = p.Participant
		}
		return fmt.Sprintf("  %s %s %s %s %s",
			stamp, mark, who, verb, u.dim(fmt.Sprintf("— %s watching", plural(r.watching(), "connection"))))
	}

	var bits []string
	for _, kv := range []struct{ k, v string }{
		{"resource", r.resourceLabel(p.ResourceID)}, {"annotation", p.AnnotationID},
		{"job", p.JobID}, {"name", p.Name}, {"", p.Message},
	} {
		if kv.v == "" {
			continue
		}
		if kv.k == "" {
			bits = append(bits, kv.v)
		} else {
			bits = append(bits, kv.k+"="+kv.v)
		}
	}
	return fmt.Sprintf("  %s %-28s %s", stamp, ev.Channel, u.dim(strings.Join(bits, "  ")))
}

// plural renders "1 connection" / "2 connections" — English-only, which is
// what the CLI is. (The Browser localizes; this does not.)
func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}
