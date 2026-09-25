package launcher

import (
	"encoding/json"
	"errors"
	"fmt"
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
// the health endpoints. Schema 2 single-stack files are migrated on read;
// schema 1 is refused rather than read (LoadStackSet says why).

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
	// unreadable: why the file on disk could not be understood, nil when it
	// was (an ABSENT file included — no record is a clean, expected state).
	//
	// It rides the set, unexported, because the only other thing a reader
	// could be handed is an EMPTY set — and empty is not the absence of an
	// answer, it is the answer "this machine has no stacks", which is the one
	// wrong answer that costs the user a running stack: stop finds nothing to
	// stop, status shows nothing, the containers and the codespace keep
	// running (and billing). Every command that draws a conclusion from the
	// set calls refuseUnreadable first, for the same reason stop refuses a
	// --runtime that mismatches the record.
	unreadable error
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
// schema 3. Schema 1 is not read (see below).
//
// A file this launcher cannot turn into stacks does NOT come back as an empty
// set: the set carries why, and refuseUnreadable turns that into a refusal at
// the verb that asked. Absence is the only clean way to have no stacks.
func LoadStackSet() *StackSet {
	ss := &StackSet{Schema: 3, Stacks: map[string]*StackState{}}
	p := statePath()
	if p == "" {
		return ss
	}
	b, err := os.ReadFile(p)
	if err != nil {
		if !os.IsNotExist(err) {
			ss.unreadable = err
		}
		return ss
	}
	var probe struct {
		Schema int             `json:"schema"`
		Stacks json.RawMessage `json:"stacks"`
	}
	if err := json.Unmarshal(b, &probe); err != nil {
		ss.unreadable = err
		return ss
	}
	if probe.Stacks != nil {
		var full StackSet
		if err := json.Unmarshal(b, &full); err != nil {
			ss.unreadable = err
			return ss
		}
		if full.Stacks == nil {
			ss.unreadable = errors.New(`"stacks" is present but holds no stacks`)
			return ss
		}
		full.Schema = 3
		return &full
	}
	// Legacy single-stack file (schema 2).
	//
	// Schema 1 is NOT read. It predates `provided`, marking host reuse with a
	// `hostReuse` bool that no longer exists on the struct, so a schema-1
	// record would load with every service unclassified — and an unclassified
	// entry is worse than no record at all: teardown would treat a host
	// process as launcher-owned. Refusing to read it is therefore right;
	// refusing SILENTLY is not, so it lands here rather than as no record.
	if probe.Schema < 2 {
		ss.unreadable = errors.New("schema 1 predates the `provided` field, so its services cannot be told apart from host processes")
		return ss
	}
	var st StackState
	if err := json.Unmarshal(b, &st); err != nil {
		ss.unreadable = err
		return ss
	}
	if st.Services == nil {
		ss.unreadable = errors.New(`schema 2 record with no "services" object`)
		return ss
	}
	ss.Stacks[stackKey(&st)] = &st
	return ss
}

// refuseUnreadable prints the refusal for a record this launcher could not
// read and reports whether the caller must stop. Every command that consults
// the recorded set calls it before acting: an unreadable record leaves the
// launcher unable to tell a running stack from none, and the fix is the
// user's to make — nothing here can guess what the file was meant to say.
func (ss *StackSet) refuseUnreadable(u *UI) bool {
	if ss.unreadable == nil {
		return false
	}
	p := statePath()
	u.Fail("Cannot read the stack record: %v", ss.unreadable)
	fmt.Fprintf(os.Stderr, "  %s exists, so a stack was started here — but this launcher\n", p)
	fmt.Fprintln(os.Stderr, "  cannot read it, and treating that as \"no stacks recorded\" would report")
	fmt.Fprintln(os.Stderr, "  nothing to stop while the real stack keeps running.")
	fmt.Fprintln(os.Stderr, "  Set the record aside, then stop what is running by name:")
	fmt.Fprintf(os.Stderr, "    mv %s %s.unreadable\n", p, p)
	fmt.Fprintln(os.Stderr, "    semiont stop          (sweeps this machine's containers by name)")
	fmt.Fprintln(os.Stderr, "    gh codespace list     (a codespace stack stops there)")
	return true
}

// loadLocalState: the machine's one local stack record, or nil. Every caller
// sits inside a flow that already refused an unreadable record at its entry —
// this shorthand cannot refuse, because nil here reads as "no local stack".
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
	// A record this launcher could not read is the only evidence of what may
	// still be running, and every command that gets here has already refused
	// on it — so nothing should be overwriting it. Belt and braces: writing
	// would destroy that evidence and silently replace it with a set built
	// from the one stack this call happens to know about.
	if ss.unreadable != nil {
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
