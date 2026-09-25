package launcher

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// KB-root discovery: SEMIONT_ROOT is an explicit override analogous to
// GIT_DIR — strictly validated, never silently ignored — else the root is
// found by walking up from cwd looking for .semiont/. git is deliberately NOT
// part of discovery; whether the root must also be a git clone is a separate
// invariant, enforced only where the /kb mount makes it real (full start,
// --service gateway).
//
// Today there is one root; the plural-ready shape (status's SEMIONT ROOTS
// section, the source annotation) anticipates supporting many.

// resolveKBRoot returns the KB root and where it came from ("SEMIONT_ROOT"
// or "discovered").
func resolveKBRoot() (path, source string, err error) {
	if override := os.Getenv("SEMIONT_ROOT"); override != "" {
		if fi, statErr := os.Stat(override); statErr != nil || !fi.IsDir() {
			return "", "", fmt.Errorf("SEMIONT_ROOT points to non-existent directory: %s", override)
		}
		if fi, statErr := os.Stat(filepath.Join(override, ".semiont")); statErr != nil || !fi.IsDir() {
			return "", "", fmt.Errorf("SEMIONT_ROOT does not contain a .semiont/ directory: %s", override)
		}
		if abs, absErr := filepath.Abs(override); absErr == nil {
			override = abs
		}
		return override, "SEMIONT_ROOT", nil
	}

	dir, err := os.Getwd()
	if err != nil {
		return "", "", fmt.Errorf("cannot determine current directory: %v", err)
	}
	for {
		if fi, statErr := os.Stat(filepath.Join(dir, ".semiont")); statErr == nil && fi.IsDir() {
			return dir, "discovered", nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", "", fmt.Errorf("no .semiont/ directory found in the current directory or any parent")
		}
		dir = parent
	}
}

// --- The roots registry ---
//
// roots.json (beside stack.json in the XDG state home) is the launcher's
// memory of every KB root it has actually used: real start flows upsert an
// entry; entries survive stops. A vanished path is annotated when observed,
// not silently dropped — an unmounted volume may come back. This registry is
// the substrate for multi-root support, for `--root <name>` selection, and
// for sticky preferences: per-KB ones (config) live on the root's entry,
// machine-wide ones (runtime — stacks are singleton-per-machine today) live
// at the top level. Per-user-per-machine facts belong beside the KB, never
// inside it.

type rootEntry struct {
	Path        string    `json:"path"`
	Did         string    `json:"did,omitempty"`      // did:web identity from .semiont/config [site] domain
	SiteName    string    `json:"siteName,omitempty"` // human label — kept here so even a missing root stays identifiable
	Config      string    `json:"config,omitempty"`   // sticky --config: the config `init` wrote, then whatever a successful start last used explicitly
	LastUsed    time.Time `json:"lastUsed"`
	LastStarted time.Time `json:"lastStarted,omitzero"` // last full-stack start
}

type rootsRegistry struct {
	Schema  int                  `json:"schema"`
	Runtime string               `json:"runtime,omitempty"` // sticky --runtime: what a successful start last used explicitly
	Secrets map[string]secretRef `json:"secrets,omitempty"` // env var → {provider, path} POINTERS (never values)
	Roots   []rootEntry          `json:"roots"`
}

func rootsPath() string {
	dir := StateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "roots.json")
}

// loadRoots returns the registry, most-recently-used first (empty, never
// nil-fielded, when absent or unreadable).
func loadRoots() rootsRegistry {
	reg := rootsRegistry{Schema: 1}
	p := rootsPath()
	if p == "" {
		return reg
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return reg
	}
	_ = json.Unmarshal(b, &reg)
	sort.Slice(reg.Roots, func(i, j int) bool { return reg.Roots[i].LastUsed.After(reg.Roots[j].LastUsed) })
	return reg
}

// registerRootUse upserts a root into the registry. Best-effort: registry
// trouble never fails the command. fullStart additionally stamps LastStarted;
// a non-empty config records the KB's sticky --config preference (callers
// pass it only after the start SUCCEEDED with an explicit --config — a typo'd
// or unlaunchable config must never become the default).
func registerRootUse(path string, fullStart bool, config string) {
	p := rootsPath()
	if p == "" {
		return
	}
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	reg := loadRoots()
	now := time.Now().UTC()
	// Identity refreshes on every use — the KB's .semiont/config can change.
	ident := loadKBIdentity(path)
	// A moved KB re-registers its did at the new path, leaving the old
	// path's row a corpse nothing else removes (and a basename collision
	// for --root). Drop rows claiming THIS did at OTHER paths that no
	// longer exist on disk; a same-did row whose path exists is a live
	// clone, not a corpse, and stays.
	if did := ident.didWeb(); did != "" {
		kept := reg.Roots[:0]
		for _, e := range reg.Roots {
			if e.Did == did && e.Path != path {
				if _, err := os.Stat(e.Path); err != nil {
					continue
				}
			}
			kept = append(kept, e)
		}
		reg.Roots = kept
	}
	found := false
	for i := range reg.Roots {
		if reg.Roots[i].Path == path {
			reg.Roots[i].LastUsed = now
			if fullStart {
				reg.Roots[i].LastStarted = now
			}
			if config != "" {
				reg.Roots[i].Config = config
			}
			if ident != nil {
				reg.Roots[i].Did = ident.didWeb()
				reg.Roots[i].SiteName = ident.SiteName
			}
			found = true
		}
	}
	if !found {
		e := rootEntry{Path: path, LastUsed: now, Did: ident.didWeb(), Config: config}
		if ident != nil {
			e.SiteName = ident.SiteName
		}
		if fullStart {
			e.LastStarted = now
		}
		reg.Roots = append(reg.Roots, e)
	}
	saveRoots(reg)
}

// saveRoots writes the registry atomically. Best-effort, like every registry
// touch: trouble here never fails the command.
func saveRoots(reg rootsRegistry) {
	p := rootsPath()
	if p == "" {
		return
	}
	if reg.Schema == 0 {
		reg.Schema = 1
	}
	b, err := json.MarshalIndent(reg, "", "  ")
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

// recordRuntimePref stores the machine-wide sticky runtime — callers pass it
// only after a start SUCCEEDED with an explicit --runtime. Unlike the config
// preference it needs no root: `--service browser --runtime docker` is a
// legitimate rootless start and still expresses the choice.
func recordRuntimePref(rt string) {
	reg := loadRoots()
	if reg.Runtime == rt {
		return
	}
	reg.Runtime = rt
	saveRoots(reg)
}

// configForRealm names the config a realm-administering command must read:
// the RUNNING stack's, else this root's sticky preference.
//
// The running stack is the authority, and asking the preference alone was a
// hard block: `start` records the RESOLVED config in stack.json on every
// start, while roots.json holds only the sticky preference, which a bare
// `semiont start` deliberately never writes (an unlaunchable --config must not
// become the default). So the documented first run — start, then useradd —
// refused on a healthy stack and advised a start that would change nothing.
func configForRealm(root string) string {
	if abs, err := filepath.Abs(root); err == nil {
		root = abs
	}
	if st := loadLocalState(); st != nil && st.KBRoot == root && st.Config != "" {
		return st.Config
	}
	return recordedConfig(root)
}

// recordedConfig returns the KB's sticky config preference — the name a
// successful start last passed as --config for this root ("" when none).
func recordedConfig(path string) string {
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	for _, e := range loadRoots().Roots {
		if e.Path == path {
			return e.Config
		}
	}
	return ""
}

// resolveRootArg resolves a `--root` value: an existing directory path is
// validated directly (strict, like SEMIONT_ROOT); anything else is looked up
// in the registry by basename.
func resolveRootArg(arg string) (string, error) {
	if fi, err := os.Stat(arg); err == nil && fi.IsDir() {
		if fi, err := os.Stat(filepath.Join(arg, ".semiont")); err != nil || !fi.IsDir() {
			return "", fmt.Errorf("--root does not contain a .semiont/ directory: %s", arg)
		}
		if abs, err := filepath.Abs(arg); err == nil {
			arg = abs
		}
		return arg, nil
	}
	if strings.ContainsRune(arg, os.PathSeparator) {
		return "", fmt.Errorf("--root points to non-existent directory: %s", arg)
	}
	reg := loadRoots()
	var matches []string
	for _, e := range reg.Roots {
		if filepath.Base(e.Path) == arg {
			matches = append(matches, e.Path)
		}
	}
	switch len(matches) {
	case 0:
		known := make([]string, 0, len(reg.Roots))
		for _, e := range reg.Roots {
			known = append(known, e.Path)
		}
		if len(known) == 0 {
			return "", fmt.Errorf("--root '%s' is not a directory and no roots are registered yet (roots register on start)", arg)
		}
		return "", fmt.Errorf("--root '%s' matches no registered root; known roots:\n  %s", arg, strings.Join(known, "\n  "))
	case 1:
		path := matches[0]
		if fi, err := os.Stat(filepath.Join(path, ".semiont")); err != nil || !fi.IsDir() {
			return "", fmt.Errorf("registered root %s is missing on disk (or lost its .semiont/)", path)
		}
		return path, nil
	default:
		return "", fmt.Errorf("--root '%s' is ambiguous; use a full path:\n  %s", arg, strings.Join(matches, "\n  "))
	}
}

// requireGitClone enforces the /kb-mount invariant: the gateway versions the
// event log via git, so a real clone is mandatory wherever /kb is mounted.
// Fails with instructions rather than git's opaque fatal when someone used
// GitHub's "Download ZIP" (or has no git at all).
func requireGitClone(u *UI, root string) bool {
	if _, err := capture("git", "-C", root, "rev-parse", "--show-toplevel"); err != nil {
		u.Fail("The KB root must be a git clone (the gateway versions the event log via git): %s", root)
		fmt.Fprintln(os.Stderr, "  If you used GitHub's 'Download ZIP', clone the repository instead:  git clone <repo-url>")
		return false
	}
	return true
}

// icloudZone classifies a KB root against the macOS iCloud-managed areas:
// "mobile" under ~/Library/Mobile Documents (always iCloud), "desktop" under
// ~/Desktop or ~/Documents (iCloud only when "Desktop & Documents Folders"
// sync is on), "" elsewhere. Pure so it is testable off-macOS; the darwin
// gate and the sync-setting read live in warnICloudRoot.
func icloudZone(root, home string) string {
	if home == "" {
		return ""
	}
	under := func(dir string) bool {
		p := filepath.Join(home, dir)
		return root == p || strings.HasPrefix(root, p+string(os.PathSeparator))
	}
	switch {
	case under(filepath.Join("Library", "Mobile Documents")):
		return "mobile"
	case under("Desktop"), under("Documents"):
		return "desktop"
	}
	return ""
}

// warnICloudRoot: a KB under an iCloud-managed folder can fail container
// reads — iCloud evicts file content ("dataless" files), and a read through
// the bind mount then surfaces inside the VM as errno -35 (EDEADLK), which
// Node reports as "Unknown system error -35". The observed shape (friction
// log 2026-07-20): first boot fine, every boot after the event log is
// non-empty crashes the view-materializer scan. A WARNING, not a refusal —
// the same setup also ran for months, because eviction state isn't stable.
// Desktop/Documents warn only when Finder says the sync is actually on
// (FXICloudDriveDesktop=1) — a Desktop KB on a non-synced Mac is fine and
// must not nag.
func warnICloudRoot(u *UI, root string) {
	if runtime.GOOS != "darwin" {
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	zone := icloudZone(root, home)
	if zone == "desktop" {
		out, err := capture("defaults", "read", "com.apple.finder", "FXICloudDriveDesktop")
		if err != nil || strings.TrimSpace(out) != "1" {
			return
		}
	}
	if zone != "" {
		u.Warn("KB root %s is in an iCloud-managed folder — container reads can fail on iCloud-evicted files (errno -35), typically once the event log is non-empty. Prefer a non-synced path (e.g. ~/Developer).", root)
	}
}

const forgetUsage = `Usage: semiont forget <path|name>

Drop one root from the launcher's registry — the "semiont roots" listing and
--root resolution. The registry only remembers: forgetting deletes no KB
files and no stack state. The running stack's root is refused; stop first.

  <path|name>   The root's path as listed, or its directory basename when
                that names exactly one entry (a moved KB's old row keeps the
                basename, so name collisions list the candidates).
  --help        Show this help
`

// Forget removes a registry row: the exit for entries whose directory is
// gone (a moved KB, a deleted trial root), which the registry's
// annotate-don't-drop policy otherwise keeps forever.
func Forget(args []string) int {
	u := NewUI(false)
	arg := ""
	for _, a := range args {
		switch a {
		case "--help", "-h":
			fmt.Print(forgetUsage)
			return 0
		default:
			if strings.HasPrefix(a, "-") || arg != "" {
				u.Fail("Unknown argument: %s", a)
				return 1
			}
			arg = a
		}
	}
	if arg == "" {
		fmt.Print(forgetUsage)
		return 1
	}
	reg := loadRoots()
	var matches []int
	abs, _ := filepath.Abs(arg)
	for i, e := range reg.Roots {
		if e.Path == arg || e.Path == abs {
			matches = []int{i}
			break
		}
	}
	if len(matches) == 0 {
		for i, e := range reg.Roots {
			if filepath.Base(e.Path) == arg {
				matches = append(matches, i)
			}
		}
	}
	switch {
	case len(matches) == 0:
		u.Fail("%q is not in the registry.", arg)
		fmt.Fprintln(os.Stderr, "  Registered roots: semiont roots")
		return 1
	case len(matches) > 1:
		u.Fail("%q names %d registered roots — forget one by its full path:", arg, len(matches))
		for _, i := range matches {
			fmt.Fprintln(os.Stderr, "    "+reg.Roots[i].Path)
		}
		return 1
	}
	e := reg.Roots[matches[0]]
	ss := LoadStackSet()
	if ss.refuseUnreadable(u) {
		return 1
	}
	if st := ss.Stacks["local"]; st != nil && st.KBRoot == e.Path {
		u.Fail("%s is the running stack's root (per %s).", e.Path, statePath())
		fmt.Fprintln(os.Stderr, "  Stop it first: semiont stop")
		return 1
	}
	reg.Roots = append(reg.Roots[:matches[0]], reg.Roots[matches[0]+1:]...)
	saveRoots(reg)
	u.Ok("Forgot %s — registry entry removed. No files were deleted.", e.Path)
	// Persistent stack state is keyed by identity, not by the registry: say
	// so when some exists, or the forgotten row's state lives on unnamed.
	// UNLESS a surviving row shares the did — state keys derive from the
	// did, so that state belongs to the live twin, and suggesting `clean`
	// here offers to delete a KB the user still uses (observed live
	// 2026-09-13 on the moved family root).
	for _, other := range reg.Roots {
		if other.Did != "" && other.Did == e.Did {
			return 0
		}
	}
	if d := dataDir(); d != "" {
		key := stateKeyFor(e.Did, e.Path)
		if fi, err := os.Stat(filepath.Join(d, "roots", key)); err == nil && fi.IsDir() {
			fmt.Println("  Persistent stack state remains. Remove it: semiont clean --root " + key)
		}
	}
	return 0
}
