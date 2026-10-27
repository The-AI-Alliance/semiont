package launcher

// limits.go — the inference ceilings `semiont status` prints beside each
// model, sourced from the PLATFORM and nowhere else.
//
// The launcher is a bus client here like every other client. The services
// that hold the inference credentials report their models' limits — the
// worker on job:limits-requested, the librarian on gather: and
// match:limits-requested — and status asks each of them. It never asks a
// provider directly for a ceiling — Anthropic's /v1/models and Ollama's
// /api/tags are still probed elsewhere in status, but only for the runtime
// facts the platform does not publish (install/load state, key visibility,
// model identity). Platform data flows through the platform surface, in
// every language; that is what putting it in the SDK is for.
//
// Absence is the normal answer, not an error: no stack, no session, a key
// holder down, a provider it could not reach — all of them mean the row
// renders exactly as it did before. Status says what it knows and stays
// silent about the rest.

import (
	"strconv"
	"sync"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// statusCeilingTimeout bounds each bus request status makes. A verb waits 30
// seconds for its reply — right for a verb whose whole job is the exchange,
// and far too long for a decoration on a report: a wedged key holder would
// stall `semiont status` for half a minute. Matched to the other status
// probes, which give a live fact 2–3 seconds to arrive or go unreported. The
// requests run concurrently, so this is also the wait for all of them.
const statusCeilingTimeout = 3 * time.Second

// modelCeilings maps a (provider, model) pair to the ceilings the platform
// discovered for it — the granularity the inference clients discover at.
type modelCeilings map[string]api.InferenceLimits

func ceilingKey(provider, model string) string { return provider + "\x00" + model }

// fetchModelCeilings asks every key holder on the local stack for its models'
// limits and indexes what they report. A nil or partial result is the answer
// for every unhappy path, and callers need not tell them apart: "no ceiling
// to show" is one outcome however it arose.
func fetchModelCeilings(u *UI, st *StackState) modelCeilings {
	if st == nil {
		return nil
	}
	base := GatewayBase(st)
	if base == "" {
		return nil
	}
	// The same session every verb holds, renewed as theirs is. No session
	// means no report, and no refusal printed: status never prompts and never
	// resolves secrets.
	sess, err := resume(u, "local", base, nil)
	if err != nil {
		return nil
	}
	defer sess.Close()
	platform := sess.Client()
	if platform.Reached() != nil {
		return nil
	}
	var (
		mu  sync.Mutex
		wg  sync.WaitGroup
		out = modelCeilings{}
	)
	for _, op := range bus.LimitsOperations {
		wg.Go(func() {
			r, err := semiont.Request(platform.Context(), platform.Wire, op, api.InferenceLimitsRequest{}, statusCeilingTimeout)
			if err != nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for _, pair := range r.Response.Limits {
				out[ceilingKey(pair.Provider, pair.Model)] = pair.Limits
			}
		})
	}
	wg.Wait()
	return out
}

// ceilingCell renders one model's ceilings. Wording matches the
// CollaborationPanel's, so the same model reads the same in the terminal and
// in the browser; the shared-window sentinel is the schema's own
// (maxOutputTokens === contextTokens means one window, not two ceilings).
func ceilingCell(l api.InferenceLimits) string {
	if l.MaxOutputTokens == l.ContextTokens {
		return formatTokens(l.ContextTokens) + " window"
	}
	return formatTokens(l.ContextTokens) + " in / " + formatTokens(l.MaxOutputTokens) + " out"
}

// formatTokens reads a token count as a ceiling — "200K" carries the meaning
// a bare 200000 makes the reader compute — without rounding one away: a
// 128000 window must never display as 130K.
func formatTokens(n float64) string {
	switch {
	case n >= 1_000_000:
		return trimUnit(n/1_000_000) + "M"
	case n >= 1_000:
		return trimUnit(n/1_000) + "K"
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
