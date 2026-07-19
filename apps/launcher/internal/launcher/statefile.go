package launcher

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// The launcher records what it believes the current stack IS — which runtime
// started it, and each service's container name, runtime-reported ID, and
// image — in stack.json under the XDG state home. stop and status compute
// their work from these identifiers (falling back to the historical
// all-runtimes name sweep only when no record exists, e.g. a stack started
// by an older launcher). The record is belief, not ground truth: status
// still verifies every claim against the runtime and the health endpoints.

type serviceState struct {
	Container string    `json:"container"`           // container name
	ID        string    `json:"id,omitempty"`        // identifier the runtime printed at run -d
	Image     string    `json:"image,omitempty"`     // full image ref
	HostReuse bool      `json:"hostReuse,omitempty"` // inference served by a host Ollama, no container
	StartedAt time.Time `json:"startedAt"`
}

type stackState struct {
	Schema    int                     `json:"schema"`
	UpdatedAt time.Time               `json:"updatedAt"`
	Launcher  string                  `json:"launcherVersion"`
	Runtime   string                  `json:"runtime"`
	KBRoot    string                  `json:"kbRoot,omitempty"`
	Config    string                  `json:"config,omitempty"`
	Version   string                  `json:"imageVersion,omitempty"`
	HostAddr  string                  `json:"hostAddr,omitempty"`
	Stage     string                  `json:"configStage,omitempty"`
	Services  map[string]serviceState `json:"services"`
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

// loadState returns the recorded stack state, or nil when none exists (or it
// is unreadable/corrupt — treated as no record, never as an error).
func loadState() *stackState {
	p := statePath()
	if p == "" {
		return nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var st stackState
	if json.Unmarshal(b, &st) != nil || st.Services == nil {
		return nil
	}
	return &st
}

// saveState writes the record atomically (temp + rename). Best-effort: a
// failure to record belief never fails the command that formed it.
func saveState(st *stackState) {
	p := statePath()
	if p == "" {
		return
	}
	st.UpdatedAt = time.Now().UTC()
	st.Launcher = BuildVersion
	if st.Schema == 0 {
		st.Schema = 1
	}
	b, err := json.MarshalIndent(st, "", "  ")
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

// removeState forgets the stack (full stop).
func removeState() {
	if p := statePath(); p != "" {
		_ = os.Remove(p)
	}
}

// recordService updates one service's entry and saves.
func (st *stackState) recordService(role, id, image string, hostReuse bool) {
	st.Services[role] = serviceState{
		Container: roles[role].container,
		ID:        id,
		Image:     image,
		HostReuse: hostReuse,
		StartedAt: time.Now().UTC(),
	}
	saveState(st)
}
