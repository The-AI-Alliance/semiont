package launcher

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// The launcher records what it believes each stack IS in stack.json under
// the XDG state home. Schema 3 is a KEYED COLLECTION: the machine's one
// LOCAL stack under "local" (fixed ports and container names keep it
// singleton), plus one entry per codespace stack under "codespace:<repo>" —
// codespace stacks don't collide in the cloud, so many may run at once,
// each forwarding its KB on its own local port (4000, else allocated above
// it); local ports are the only contention point. stop and status compute their
// work from these identifiers (falling back to the historical all-runtimes
// name sweep only when no record exists). The record is belief, not ground
// truth: status still verifies every claim against the runtime, gh, and
// the health endpoints. Schema 1/2 single-stack files are migrated on read.

// Provided values (schema 2): who provides this role.
const (
	providedLauncher = "launcher" // a container this launcher started
	providedHost     = "host"     // a host process (reused, not launched)
	providedExternal = "external" // config-declared external endpoint
	providedNone     = "none"     // not referenced by the config
)

type serviceState struct {
	Container string   `json:"container,omitempty"` // container name (launcher-provided only)
	ID        string   `json:"id,omitempty"`        // identifier the runtime printed at run -d
	Image     string   `json:"image,omitempty"`     // full image ref
	Provided  string   `json:"provided,omitempty"`  // schema 2: launcher|host|external|none
	Driver    string   `json:"driver,omitempty"`    // config `type` (infra roles)
	Models    []string `json:"models,omitempty"`    // models this role uses, per the config it started with
	// OllamaServed: the subset of Models that Ollama serves — the only ones
	// with an install state. Deliberately NOT omitempty: an EMPTY set ("this
	// role's models are all remote") must stay distinguishable on read from an
	// ABSENT field ("record predates this field"), and omitempty collapses
	// both to nil. That collapse is what let an all-Claude inference row fall
	// back to its ollama driver and report MISSING.
	OllamaServed []string `json:"ollamaServed"`
	// RemoteModels: /v1/models metadata for SaaS-served models, keyed by id,
	// recorded at start (the key is in hand then; status never reaches for
	// secrets). Availability means "as of that start" — status refreshes it
	// live only when the key happens to be in its environment.
	RemoteModels map[string]remoteModelMeta `json:"remoteModels,omitempty"`
	Endpoint     string                     `json:"endpoint,omitempty"`  // health probe: http(s) URL or tcp:<host>:<port>
	HostReuse    bool                       `json:"hostReuse,omitempty"` // schema 1 (read-compat only; no longer written)
	StartedAt    time.Time                  `json:"startedAt"`
}

type stackState struct {
	Schema      int                     `json:"schema,omitempty"` // legacy single-stack files only (read-compat)
	UpdatedAt   time.Time               `json:"updatedAt"`
	Runtime     string                  `json:"runtime"`
	KBRoot      string                  `json:"kbRoot,omitempty"`
	KBDid       string                  `json:"kbDid,omitempty"` // did:web from .semiont/config
	Config      string                  `json:"config,omitempty"`
	Version     string                  `json:"imageVersion,omitempty"`
	HostAddr    string                  `json:"hostAddr,omitempty"`
	Stage       string                  `json:"configStage,omitempty"`
	Ports       []int                   `json:"ports,omitempty"`       // host ports this stack claimed — stop verifies their release
	Codespace   string                  `json:"codespace,omitempty"`   // runtime "codespace": the instance name (a PID — never user input)
	Repo        string                  `json:"repo,omitempty"`        // runtime "codespace": owner/name slug (the user-facing identity)
	ForwardPID  int                     `json:"forwardPid,omitempty"`  // runtime "codespace": the detached `gh codespace ports forward`
	ForwardPort int                     `json:"forwardPort,omitempty"` // runtime "codespace": this stack's local KB port (4000, or allocated above)
	Services    map[string]serviceState `json:"services"`
}

// stateDir is the launcher's XDG state home: ~/Library/Application Support/
// semiont on macOS (Apple's state-and-config home), $XDG_STATE_HOME/semiont
// (default ~/.local/state/semiont) elsewhere. "" when no home is resolvable.
func stateDir() string {
	if runtime.GOOS == "darwin" {
		dir, err := os.UserConfigDir()
		if err != nil {
			return ""
		}
		return filepath.Join(dir, "semiont")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	if s := os.Getenv("XDG_STATE_HOME"); s != "" {
		return filepath.Join(s, "semiont")
	}
	return filepath.Join(home, ".local", "state", "semiont")
}

func statePath() string {
	dir := stateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "stack.json")
}

// stackSet is the on-disk shape (schema 3): every recorded stack, keyed.
type stackSet struct {
	Schema    int                    `json:"schema"`
	UpdatedAt time.Time              `json:"updatedAt"`
	Launcher  string                 `json:"launcherVersion"`
	Stacks    map[string]*stackState `json:"stacks"`
}

// stackKey: "local" for the machine's one local stack, "codespace:<repo>"
// per codespace stack (the repo is the user-facing identity there).
func stackKey(st *stackState) string {
	if st.Runtime == "codespace" {
		return "codespace:" + st.Repo
	}
	return "local"
}

// loadStackSet returns every recorded stack (never nil; empty when no file).
// Schema 1/2 single-stack files migrate in memory — the next save writes
// schema 3.
func loadStackSet() *stackSet {
	ss := &stackSet{Schema: 3, Stacks: map[string]*stackState{}}
	p := statePath()
	if p == "" {
		return ss
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return ss
	}
	var probe struct {
		Schema int             `json:"schema"`
		Stacks json.RawMessage `json:"stacks"`
	}
	if json.Unmarshal(b, &probe) != nil {
		return ss
	}
	if probe.Stacks != nil {
		var full stackSet
		if json.Unmarshal(b, &full) == nil && full.Stacks != nil {
			full.Schema = 3
			return &full
		}
		return ss
	}
	// Legacy single-stack file (schema 1/2).
	var st stackState
	if json.Unmarshal(b, &st) != nil || st.Services == nil {
		return ss
	}
	if probe.Schema < 2 { // schema 1: hostReuse was the only non-launcher marker
		for role, e := range st.Services {
			if e.Provided == "" {
				e.Provided = providedLauncher
				if e.HostReuse {
					e.Provided = providedHost
				}
				st.Services[role] = e
			}
		}
	}
	ss.Stacks[stackKey(&st)] = &st
	return ss
}

// loadLocalState: the machine's one local stack record, or nil.
func loadLocalState() *stackState {
	return loadStackSet().Stacks["local"]
}

// codespaceStacks: every recorded codespace stack, sorted by repo.
func codespaceStacks(ss *stackSet) []*stackState {
	var out []*stackState
	for k, st := range ss.Stacks {
		if strings.HasPrefix(k, "codespace:") {
			out = append(out, st)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Repo < out[j].Repo })
	return out
}

// saveStackSet writes the collection atomically (temp + rename); an empty
// set removes the file — "no record" stays a clean, observable state.
// Best-effort: a failure to record belief never fails the command.
func saveStackSet(ss *stackSet) {
	p := statePath()
	if p == "" {
		return
	}
	if len(ss.Stacks) == 0 {
		_ = os.Remove(p)
		writeDiscovery(ss) // empty list, not an absent file
		return
	}
	ss.Schema = 3
	ss.UpdatedAt = time.Now().UTC()
	ss.Launcher = BuildVersion
	// The Browser's discovery view rides every mutation — same single
	// writer, same moments (BROWSER-KB-DISCOVERY.md lane 1).
	defer writeDiscovery(ss)
	b, err := json.MarshalIndent(ss, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, p)
}

// saveStack upserts one stack into the collection.
func saveStack(st *stackState) {
	st.UpdatedAt = time.Now().UTC()
	st.Schema = 0 // schema lives on the set now
	ss := loadStackSet()
	ss.Stacks[stackKey(st)] = st
	saveStackSet(ss)
}

// forgetStack removes one stack from the collection (full local stop,
// codespace delete). Other stacks' records survive.
func forgetStack(key string) {
	ss := loadStackSet()
	delete(ss.Stacks, key)
	saveStackSet(ss)
}

// recordService updates one service's entry and saves. provided says who
// provides the role; endpoint is the health probe status should use.
func (st *stackState) recordService(role, id, image, provided, endpoint, driver string, models, ollamaServed []string) {
	e := serviceState{
		ID:           id,
		Image:        image,
		Provided:     provided,
		Endpoint:     endpoint,
		Driver:       driver,
		Models:       models,
		OllamaServed: ollamaServed,
		StartedAt:    time.Now().UTC(),
	}
	if provided == providedLauncher {
		e.Container = roles[role].container
		// A container-less role (embedding) gets NO container here even when
		// provided reads "launcher" — that value may be INHERITED from the
		// role that runs its Ollama (SharesOllamaWith), and stamping a
		// container it does not own would let `stop --service embedding`
		// sweep inference's Ollama. Ownership is explicit: only the flow that
		// actually launched the container records one (noteContainer).
	}
	st.Services[role] = e
	saveStack(st)
}
