package launcher

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
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

type ServiceState struct {
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
	Endpoint     string                     `json:"endpoint,omitempty"` // health probe: http(s) URL or tcp:<host>:<port>
	Runtime      string                     `json:"runtime,omitempty"`  // browser record only: the runtime that runs it (stack services get theirs from the stack)
	StartedAt    time.Time                  `json:"startedAt"`
}

type StackState struct {
	Schema    int       `json:"schema,omitempty"` // legacy single-stack files only (read-compat)
	UpdatedAt time.Time `json:"updatedAt"`
	Runtime   string    `json:"runtime"`
	KBRoot    string    `json:"kbRoot,omitempty"`
	KBDid     string    `json:"kbDid,omitempty"` // did:web from .semiont/config
	Config    string    `json:"config,omitempty"`
	Version   string    `json:"imageVersion,omitempty"`
	HostAddr  string    `json:"hostAddr,omitempty"`
	Stage     string    `json:"configStage,omitempty"`
	Ports     []int     `json:"ports,omitempty"` // host ports this stack claimed — stop verifies their release
	// Codespace: the placement facts a stack on a codespace has and a local
	// one cannot. Its PRESENCE is the platform (D5) — there is no separate
	// platform field to keep in sync with it, and no local stack carrying
	// four zeroed codespace fields for every reader to test one at a time.
	Codespace *codespacePlacement     `json:"codespace,omitempty"`
	Services  map[string]ServiceState `json:"services"`
}

// codespacePlacement: where a codespace stack is and how this machine
// reaches it. Runtime stays empty on one of these — compose owns the
// services inside, so there is no container runtime of ours to name.
type codespacePlacement struct {
	Name        string `json:"name"`                  // the instance name (a PID — never user input)
	Repo        string `json:"repo"`                  // owner/name slug (the user-facing identity)
	ForwardPID  int    `json:"forwardPid,omitempty"`  // the detached `gh codespace ports forward`
	ForwardPort int    `json:"forwardPort,omitempty"` // this stack's local KB port (4000, or allocated above)
}

// platform: derived from the record's shape, never stored beside it. A stack
// lives on a codespace exactly when it has a placement.
func (st *StackState) platform() platform {
	if st.Codespace != nil {
		return platformCodespace
	}
	return platformLocal
}

// StateDir is the launcher's XDG state home: ~/Library/Application Support/
// semiont on macOS (Apple's state-and-config home), $XDG_STATE_HOME/semiont
// (default ~/.local/state/semiont) elsewhere. "" when no home is resolvable.
func StateDir() string {
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
	dir := StateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "stack.json")
}

// StackSet is the on-disk shape (schema 3): every recorded stack, keyed.
type StackSet struct {
	Schema    int                    `json:"schema"`
	UpdatedAt time.Time              `json:"updatedAt"`
	Launcher  string                 `json:"launcherVersion"`
	Stacks    map[string]*StackState `json:"stacks"`
	// Browser: the machine-level viewer, deliberately OUTSIDE every stack
	// (BROWSER-LIFECYCLE.md): it serves any number of KBs, any start ensures
	// it, and stopping a stack leaves it running.
	Browser *ServiceState `json:"browser,omitempty"`
}

// stackKey: "local" for the machine's one local stack, "codespace:<repo>"
// per codespace stack (the repo is the user-facing identity there).
func stackKey(st *StackState) string {
	if st.Codespace != nil {
		return "codespace:" + st.Codespace.Repo
	}
	return "local"
}

// LoadStackSet returns every recorded stack (never nil; empty when no file).
// Schema 2 single-stack files migrate in memory — the next save writes
// schema 3. Schema 1 is no longer read (see below).
func LoadStackSet() *StackSet {
	ss := &StackSet{Schema: 3, Stacks: map[string]*StackState{}}
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
		var full StackSet
		if json.Unmarshal(b, &full) == nil && full.Stacks != nil {
			full.Schema = 3
			return &full
		}
		return ss
	}
	// Legacy single-stack file (schema 2).
	//
	// Schema 1 is NOT read. It predates `provided`, marking host reuse with a
	// `hostReuse` bool that no longer exists on the struct, so a schema-1
	// record would load with every service unclassified — and an unclassified
	// entry is worse than no record at all: teardown would treat a host
	// process as launcher-owned. No record falls back to the name sweep, which
	// is correct for a machine this old.
	if probe.Schema < 2 {
		return ss
	}
	var st StackState
	if json.Unmarshal(b, &st) != nil || st.Services == nil {
		return ss
	}
	ss.Stacks[stackKey(&st)] = &st
	return ss
}

// loadLocalState: the machine's one local stack record, or nil.
func loadLocalState() *StackState {
	return LoadStackSet().Stacks["local"]
}

// codespaceStack: the recorded stack for one repo, or nil. The key can only
// exist for a stack that HAS a placement — stackKey builds the key out of
// the placement — so a non-nil result always has one, and every caller that
// goes through here may read it without asking again. This function is where
// that invariant is stated, instead of at six lookups that each assumed it.
func codespaceStack(ss *StackSet, repo string) *StackState {
	st := ss.Stacks["codespace:"+repo]
	if st == nil || st.Codespace == nil {
		return nil
	}
	return st
}

// codespaceStacks: every recorded codespace stack, sorted by repo.
func codespaceStacks(ss *StackSet) []*StackState {
	var out []*StackState
	for _, st := range ss.Stacks {
		if st.platform() == platformCodespace {
			out = append(out, st)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Codespace.Repo < out[j].Codespace.Repo })
	return out
}

// saveStackSet writes the collection atomically (temp + rename); an empty
// set removes the file — "no record" stays a clean, observable state.
// Best-effort: a failure to record belief never fails the command.
func saveStackSet(ss *StackSet) {
	p := statePath()
	if p == "" {
		return
	}
	if len(ss.Stacks) == 0 && ss.Browser == nil {
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
func saveStack(st *StackState) {
	st.UpdatedAt = time.Now().UTC()
	st.Schema = 0 // schema lives on the set now
	ss := LoadStackSet()
	ss.Stacks[stackKey(st)] = st
	saveStackSet(ss)
}

// forgetStack removes one stack from the collection (full local stop,
// codespace delete). Other stacks' records survive.
func forgetStack(key string) {
	ss := LoadStackSet()
	delete(ss.Stacks, key)
	saveStackSet(ss)
}

// saveBrowser upserts the machine-level browser record.
func saveBrowser(e *ServiceState) {
	ss := LoadStackSet()
	ss.Browser = e
	saveStackSet(ss)
}

// clearBrowser forgets it (the targeted `stop --service browser`).
func clearBrowser() {
	ss := LoadStackSet()
	if ss.Browser == nil {
		return
	}
	ss.Browser = nil
	saveStackSet(ss)
}

// recordService updates one service's entry and saves. provided says who
// provides the role; endpoint is the health probe status should use.
func (st *StackState) recordService(role, id, image, provided, endpoint, driver string, models, ollamaServed []string) {
	e := ServiceState{
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
		e.Container = descriptorFor(role, driver).container
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
