package launcher

// limits.go — the inference ceilings `semiont status` prints beside each
// model, sourced from the PLATFORM and nowhere else.
//
// The launcher is a bus client here like every other client: one correlated
// browse:agents-requested exchange against the local gateway, decode the
// collaborator roster, read each entry's discovered limits. It never asks a
// provider directly for a ceiling — Anthropic's /v1/models and Ollama's
// /api/tags are still probed elsewhere in status, but only for the runtime
// facts the platform does not publish (install/load state, key visibility,
// model identity). Platform data flows through the platform surface, in
// every language; that is what putting it in the SDK is for.
//
// Absence is the normal answer, not an error: no stack, no session, gateway
// down, a provider that could not be reached when the Browser enriched the
// roster — all of them mean the row renders exactly as it did before. Status
// says what it knows and stays silent about the rest.

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// statusCeilingTimeout bounds the one bus request status makes. The client's
// default is 30 seconds — right for a verb whose whole job is the exchange,
// and far too long for a decoration on a report: a wedged gateway would stall
// `semiont status` for half a minute. Matched to the other status probes,
// which give a live fact 2–3 seconds to arrive or go unreported.
const statusCeilingTimeout = 3 * time.Second

// modelCeilings maps a (provider, model) pair to the ceilings the platform
// discovered for it. The key is the roster's own dedup key — the granularity
// the inference clients discover at.
type modelCeilings map[string]semiont.InferenceLimits

func ceilingKey(provider, model string) string { return provider + "\x00" + model }

// fetchModelCeilings asks the local stack's gateway for the collaborator
// roster and indexes the entries that carry limits. A nil result is the
// answer for every unhappy path, and callers need not tell them apart:
// "no ceiling to show" is one outcome however it arose.
func fetchModelCeilings(st *stackState) modelCeilings {
	if st == nil {
		return nil
	}
	base := gatewayBase(st)
	if base == "" {
		return nil
	}
	// The same credential printSessions verifies with. No session means no
	// roster — status never prompts and never resolves secrets.
	e, ok := loadTokens()["local"]
	if !ok || e.Token == "" {
		return nil
	}
	reply, err := newTransport(base, e.Token).Request(
		context.Background(),
		bus.BrowseAgentsRequested,
		semiont.BrowseAgentsRequest{},
		&bus.RequestOptions{Timeout: statusCeilingTimeout},
	)
	if err != nil {
		return nil
	}
	var r semiont.BrowseAgentsResult
	if json.Unmarshal(reply, &r) != nil {
		return nil
	}
	out := modelCeilings{}
	for _, entry := range r.Response.Agents {
		if entry.Limits == nil {
			continue
		}
		// The schema owns the dispatch: ValueByDiscriminator switches on
		// @type and returns the right named variant, so no hand-written
		// type check can drift from the wire (WIRE-UNION-DISCRIMINANTS P5a).
		v, err := entry.Agent.ValueByDiscriminator()
		if err != nil {
			continue
		}
		sw, ok := v.(semiont.AgentSoftware)
		if !ok || sw.Provider == nil || sw.Model == nil {
			continue
		}
		out[ceilingKey(*sw.Provider, *sw.Model)] = *entry.Limits
	}
	return out
}

// ceilingProvider names the provider that serves ONE model in a role's row,
// and reports whether the record settles the question at all.
//
// It deliberately does NOT mirror printModels' isOllama: that one falls back
// to the row's driver for records written before ollamaServed existed, which
// is right for an install state (those records rendered that way before, and
// a wrong install state is visibly wrong) and wrong for a ceiling (a wrong
// number reads as a fact). Two models in one row can have two providers —
// a config can point workers at Anthropic while embedding runs on Ollama —
// so where the record cannot name this model's provider, nothing is claimed.
func ceilingProvider(model, driver string, ollamaServed []string) (string, bool) {
	if ollamaServed == nil {
		return "", false // predates the field; the driver alone is not evidence
	}
	for _, m := range ollamaServed {
		if m == model {
			return "ollama", true
		}
	}
	switch driver {
	case "":
		return "", false
	case "ollama":
		// Ollama does not serve it, yet the row claims Ollama. Whoever serves
		// this model, the record does not say. (The same confusion, trusted,
		// once advised `ollama pull claude-…`.)
		return "", false
	}
	return driver, true
}

// ceilingCell renders one model's ceilings. Wording matches the
// CollaborationPanel's, so the same model reads the same in the terminal and
// in the browser; the shared-window sentinel is the schema's own
// (maxOutputTokens === contextTokens means one window, not two ceilings).
func ceilingCell(l semiont.InferenceLimits) string {
	if l.MaxOutputTokens == l.ContextTokens {
		return formatTokens(l.ContextTokens) + " window"
	}
	return formatTokens(l.ContextTokens) + " in / " + formatTokens(l.MaxOutputTokens) + " out"
}

// formatTokens reads a token count as a ceiling — "200K" carries the meaning
// a bare 200000 makes the reader compute — without rounding one away: a
// 128000 window must never display as 130K.
func formatTokens(n float32) string {
	switch {
	case n >= 1_000_000:
		return trimUnit(float64(n)/1_000_000) + "M"
	case n >= 1_000:
		return trimUnit(float64(n)/1_000) + "K"
	default:
		return strconv.Itoa(int(n))
	}
}

func trimUnit(v float64) string {
	if v == float64(int64(v)) {
		return strconv.FormatInt(int64(v), 10)
	}
	return strconv.FormatFloat(v, 'f', 1, 64)
}
