package launcher

// initmodels.go — LAUNCHER-BIRTH P3: live model validation at birth.
// Anthropic choices validate against /v1/models when a key is in hand — a
// withdrawn or typo'd id becomes a refusal naming what exists, not a KB
// whose jobs fail later. Ollama choices validate against the local daemon
// (installed) and the ollama registry's per-name manifest probe (pullable;
// there is NO list-all API — probing a typed name is the whole surface).
// Both keep the status ladder's honesty rule: unreachable sources degrade
// to accept-with-warning — unknown is not missing.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// resolveAnthropicModel validates (key in hand) or passes through with a
// warning (keyless). model=="" with a key picks the ONE editorial default:
// the newest capable model — the API lists newest first; prefer the first
// sonnet-class id, else the newest of all (decision 7).
// defaultAnthropicModel: what init binds when it can neither be told a model
// nor fetch the list. A CHOICE, not a derivation — the same kind
// defaultOllamaModel is — and the one the template every forked KB starts
// from binds, so a born KB and a forked one agree. It is recorded
// UNVALIDATED: a model can be withdrawn, and the warning says so.
const defaultAnthropicModel = "claude-sonnet-4-5-20250929"

func resolveAnthropicModel(u *UI, base, key, model string) (string, bool) {
	if key == "" {
		if model == "" {
			// A key is needed to START, not to be born. Refusing here left
			// the caller with no config at all rather than one they could
			// edit — and the ollama path already warns and proceeds when it
			// cannot verify a model, which is the same situation.
			u.Warn("No ANTHROPIC_API_KEY in the environment, so the live list cannot be fetched — binding %s, recorded unvalidated. Pass --model to choose another.", defaultAnthropicModel)
			return defaultAnthropicModel, true
		}
		u.Warn("ANTHROPIC_API_KEY is not set — %s is recorded unvalidated (the live list needs a key; a typo surfaces only when a job runs).", model)
		return model, true
	}
	list, ok := anthropicModelList(base, key)
	if !ok || len(list) == 0 {
		if model == "" {
			u.Fail("Could not fetch the model list from %s — pass --model explicitly.", base)
			return "", false
		}
		u.Warn("Could not fetch the model list from %s — %s is recorded unvalidated.", base, model)
		return model, true
	}
	if model != "" {
		for _, m := range list {
			if m.ID == model {
				u.Ok("Model %s validated against the live list %s", model, u.Dim("("+base+")"))
				return model, true
			}
		}
		u.Fail("Model %q is not listed for this API key (withdrawn, or a typo?).", model)
		fmt.Fprintln(os.Stderr, "  Available:")
		for _, m := range list {
			fmt.Fprintf(os.Stderr, "    %-32s %s\n", m.ID, m.DisplayName)
		}
		return "", false
	}
	pick := list[0]
	for _, m := range list {
		if strings.Contains(m.ID, "sonnet") {
			pick = m
			break
		}
	}
	u.Ok("Model %s %s", u.Bold(pick.ID), u.Dim("(newest capable per the live list — override with --model)"))
	return pick.ID, true
}

type anthropicModel struct {
	ID          string
	DisplayName string
}

// anthropicModelList: /v1/models preserving the API's newest-first ORDER
// (fetchAnthropicModels returns a map for status's lookups; the picker
// needs the ordering).
func anthropicModelList(base, key string) ([]anthropicModel, bool) {
	req, err := http.NewRequest("GET", base+"/v1/models?limit=1000", nil)
	if err != nil {
		return nil, false
	}
	req.Header.Set("x-api-key", key)
	req.Header.Set("anthropic-version", "2023-06-01")
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, false
	}
	var body struct {
		Data []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"data"`
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil || json.Unmarshal(b, &body) != nil {
		return nil, false
	}
	out := make([]anthropicModel, 0, len(body.Data))
	for _, m := range body.Data {
		out = append(out, anthropicModel{ID: m.ID, DisplayName: m.DisplayName})
	}
	return out, true
}

// validateOllamaModel: installed → ok; pullable per the registry probe →
// ok (start pulls it); registry 404 → refusal; sources unreachable →
// accept-with-warning.
func validateOllamaModel(u *UI, ollamaBase, registryBase, model string) bool {
	facts := fetchModelFacts(ollamaBase)
	if facts.found {
		if _, ok := facts.installed[normalizeModel(model)]; ok {
			u.Ok("Model %s is installed %s", model, u.Dim("("+ollamaBase+")"))
			return true
		}
	}
	name, tag, hasTag := strings.Cut(model, ":")
	if !hasTag {
		tag = "latest"
	}
	url := fmt.Sprintf("%s/v2/library/%s/manifests/%s", registryBase, name, tag)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Get(url)
	if err != nil {
		u.Warn("Model %s could not be verified (registry unreachable) — recorded as typed; start will attempt the pull.", model)
		return true
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case 200:
		u.Ok("Model %s exists in the ollama registry %s", model, u.Dim("(not installed yet — pulled at start)"))
		return true
	case 404:
		// A registry 404 is a refusal ONLY when the local Ollama could be
		// consulted and did not have it — then it is a genuine typo. If
		// Ollama itself is unreachable, the model may be installed there (or
		// be a custom/local-only model) and we simply cannot know: unknown
		// is not missing (Copilot review, PR #1065).
		if !facts.found {
			u.Warn("Model %s is not in the ollama registry, and the local Ollama (%s) is unreachable — recorded as typed; verify it is installed before start.", model, ollamaBase)
			return true
		}
		u.Fail("Model %q is not in the ollama registry (404) and is not installed locally — a typo?", model)
		return false
	default:
		u.Warn("Model %s could not be verified (registry answered %d) — recorded as typed.", model, resp.StatusCode)
		return true
	}
}
