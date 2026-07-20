package launcher

// models.go — the model layer of `semiont status`. The config says which
// models a stack performs inference and embedding with; Ollama says which of
// those are actually pulled, and which are resident right now. Configured is
// BELIEF (recorded at start), installed/loaded is VERIFIED live — the same
// split the rest of the launcher keeps.
//
// This matters because nothing in the launcher pulls models. A configured
// model that was never pulled is invisible until a worker reaches for it
// mid-job and fails, so surfacing it here is the whole point.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// modelFacts is what Ollama knows: every installed model, and which are
// resident. found is false when Ollama could not be reached at all — the
// caller must then say "unknown", never "missing". Ignorance and a finding
// are different answers, and only one of them tells a user to go pull
// something they may already have.
type modelFacts struct {
	found     bool
	installed map[string]ollamaModel
	loaded    map[string]bool
}

type ollamaModel struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Details struct {
		ParameterSize     string `json:"parameter_size"`
		QuantizationLevel string `json:"quantization_level"`
	} `json:"details"`
}

// normalizeModel makes config names and Ollama names comparable: Ollama
// reports an untagged model as ":latest", so a config saying
// "nomic-embed-text" would otherwise read as MISSING when it is installed.
func normalizeModel(name string) string {
	if !strings.Contains(name, ":") {
		return name + ":latest"
	}
	return name
}

func fetchModelFacts(base string) modelFacts {
	f := modelFacts{installed: map[string]ollamaModel{}, loaded: map[string]bool{}}
	var tags struct {
		Models []ollamaModel `json:"models"`
	}
	if !getJSON(base+"/api/tags", &tags) {
		return f
	}
	f.found = true
	for _, m := range tags.Models {
		f.installed[normalizeModel(m.Name)] = m
	}
	// Resident-right-now is a bonus, not a requirement: an older Ollama
	// without /api/ps still gives a useful installed/missing answer.
	var ps struct {
		Models []ollamaModel `json:"models"`
	}
	if getJSON(base+"/api/ps", &ps) {
		for _, m := range ps.Models {
			f.loaded[normalizeModel(m.Name)] = true
		}
	}
	return f
}

func getJSON(url string, into any) bool {
	c := &http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return false
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return false
	}
	return json.Unmarshal(b, into) == nil
}

// humanSize renders bytes the way model listings do.
func humanSize(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%d MB", n/(1<<20))
	case n == 0:
		return ""
	default:
		return fmt.Sprintf("%d KB", n/(1<<10))
	}
}

// printModels renders one role's configured models beneath its row. Remote
// providers (Anthropic, Voyage) have nothing to install, so they get the name
// and an honest "remote" rather than a fabricated install state.
func printModels(u *ui, models, ollamaServed []string, driver string, facts modelFacts) {
	// Which models have an install state at all is PER MODEL, not per row: a
	// config can point its workers at Anthropic while its embedding runs on
	// Ollama, and the inference row then lists Claude models under a driver
	// of "ollama". Checking those against Ollama reported them MISSING and
	// advised `ollama pull claude-…` — nonsense (observed 2026-07-20).
	//
	// A nil ollamaServed is a record written before this field existed; fall
	// back to the row's driver so those keep rendering as they did.
	served := map[string]bool{}
	for _, m := range ollamaServed {
		served[m] = true
	}
	isOllama := func(m string) bool {
		if ollamaServed == nil {
			return driver == "ollama"
		}
		return served[m]
	}
	for _, m := range models {
		if !isOllama(m) {
			fmt.Printf("      %-24s %-28s %s\n", m, "", u.dim("remote"))
			continue
		}
		key := normalizeModel(m)
		switch {
		case !facts.found:
			fmt.Printf("      %-24s %s\n", m, u.dim("unknown — Ollama unreachable"))
		case facts.loaded[key]:
			fmt.Printf("      %-24s %s  %s\n", m, u.dim(modelMeta(facts.installed[key])), u.wrap(ansiGreen, "loaded"))
		default:
			im, ok := facts.installed[key]
			if !ok {
				fmt.Printf("      %-24s %s\n", m, u.wrap(ansiRed, "MISSING")+u.dim(" — ollama pull "+m))
				continue
			}
			fmt.Printf("      %-24s %s  %s\n", m, u.dim(modelMeta(im)), u.dim("installed"))
		}
	}
}

// modelMeta is fixed-width so the sub-rows form their own aligned columns
// under the service table rather than ragged text.
func modelMeta(m ollamaModel) string {
	return fmt.Sprintf("%9s  %8s  %-7s", humanSize(m.Size), m.Details.ParameterSize, m.Details.QuantizationLevel)
}

// ollamaBase strips a recorded health endpoint back to its origin, so the
// model probes hit the same Ollama the health row does — including a
// non-default port a config moved it to.
func ollamaBase(endpoint string) string {
	if i := strings.Index(endpoint, "/api/"); i > 0 {
		return endpoint[:i]
	}
	return "http://localhost:11434"
}

// --- pulling ---

// ensureOllamaModels pulls any configured model Ollama does not already
// have. It runs over Ollama's HTTP API rather than the `ollama` CLI or a
// `<runtime> exec`, so ONE path covers both placements — a host process and
// the launcher's own container answer the same endpoint, and no CLI needs to
// be on PATH.
//
// A model that cannot be listed is never pulled: when Ollama does not answer
// we know nothing, and blindly pulling would re-download gigabytes a user
// already has. Same rule status keeps — unknown is not missing.
func ensureOllamaModels(u *ui, base string, models []string) bool {
	if len(models) == 0 {
		return true
	}
	facts := fetchModelFacts(base)
	if !facts.found {
		u.warn("Could not list Ollama's models at %s — skipping model checks.", base)
		return true // not fatal: the stack runs, status will report what it finds
	}
	var missing []string
	for _, m := range models {
		if _, ok := facts.installed[normalizeModel(m)]; !ok {
			missing = append(missing, m)
		}
	}
	if len(missing) == 0 {
		u.ok("Models present %s", u.dim("("+strings.Join(models, ", ")+")"))
		return true
	}
	u.log("Pulling %d missing model(s): %s", len(missing), u.bold(strings.Join(missing, ", ")))
	for _, m := range missing {
		if !pullOllamaModel(u, base, m) {
			// A failed pull is NOT fatal to the stack: the other services are
			// fine and the user may prefer to pull by hand. Say plainly what
			// will break, and let status keep reporting it MISSING.
			u.warn("Could not pull %s — jobs that use it will fail until it is present (ollama pull %s).", m, m)
		}
	}
	return true
}

// pullOllamaModel streams POST /api/pull, reporting progress at intervals
// rather than per line: a multi-gigabyte pull emits thousands of updates, and
// the launcher's output is a log, not a TTY canvas.
func pullOllamaModel(u *ui, base, model string) bool {
	body, _ := json.Marshal(map[string]any{"model": model, "stream": true})
	req, err := http.NewRequest("POST", base+"/api/pull", strings.NewReader(string(body)))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	// No client timeout: a cold pull of a 20GB model legitimately runs for
	// many minutes. The stream itself is the liveness signal.
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		u.warn("pull %s: %v", model, err)
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		u.warn("pull %s: Ollama answered %s", model, resp.Status)
		return false
	}
	t0 := time.Now()
	dec := json.NewDecoder(resp.Body)
	lastReport := time.Now()
	ok := false
	for {
		var ev struct {
			Status    string `json:"status"`
			Total     int64  `json:"total"`
			Completed int64  `json:"completed"`
			Error     string `json:"error"`
		}
		if err := dec.Decode(&ev); err != nil {
			break
		}
		if ev.Error != "" {
			u.warn("pull %s: %s", model, ev.Error)
			return false
		}
		if ev.Status == "success" {
			ok = true
		}
		if ev.Total > 0 && time.Since(lastReport) > 5*time.Second {
			lastReport = time.Now()
			u.log("  %s %s", model, u.dim(fmt.Sprintf("%d%% of %s", ev.Completed*100/ev.Total, humanSize(ev.Total))))
		}
	}
	if ok {
		u.ok("Pulled %s %s", model, u.dim("("+took(time.Since(t0))+")"))
	}
	return ok
}
