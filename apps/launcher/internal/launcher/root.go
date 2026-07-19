package launcher

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// KB-root discovery, adopted from apps/cli (config-loader.ts): SEMIONT_ROOT
// is an explicit override analogous to GIT_DIR — strictly validated, never
// silently ignored — else the root is found by walking up from cwd looking
// for .semiont/. git is deliberately NOT part of discovery; whether the root
// must also be a git clone is a separate invariant, enforced only where the
// /kb mount makes it real (full start, --service backend).
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
// the substrate for multi-root support and for `--root <name>` selection.

type rootEntry struct {
	Path        string    `json:"path"`
	LastUsed    time.Time `json:"lastUsed"`
	LastStarted time.Time `json:"lastStarted,omitzero"` // last full-stack start
}

type rootsRegistry struct {
	Schema int         `json:"schema"`
	Roots  []rootEntry `json:"roots"`
}

func rootsPath() string {
	dir := stateDir()
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
// trouble never fails the command. fullStart additionally stamps LastStarted.
func registerRootUse(path string, fullStart bool) {
	p := rootsPath()
	if p == "" {
		return
	}
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	reg := loadRoots()
	now := time.Now().UTC()
	found := false
	for i := range reg.Roots {
		if reg.Roots[i].Path == path {
			reg.Roots[i].LastUsed = now
			if fullStart {
				reg.Roots[i].LastStarted = now
			}
			found = true
		}
	}
	if !found {
		e := rootEntry{Path: path, LastUsed: now}
		if fullStart {
			e.LastStarted = now
		}
		reg.Roots = append(reg.Roots, e)
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

// requireGitClone enforces the /kb-mount invariant: the backend versions the
// event log via git, so a real clone is mandatory wherever /kb is mounted.
// Fails with instructions rather than git's opaque fatal when someone used
// GitHub's "Download ZIP" (or has no git at all).
func requireGitClone(u *ui, root string) bool {
	if _, err := capture("git", "-C", root, "rev-parse", "--show-toplevel"); err != nil {
		u.fail("The KB root must be a git clone (the backend versions the event log via git): %s", root)
		fmt.Fprintln(os.Stderr, "  If you used GitHub's 'Download ZIP', clone the repository instead:  git clone <repo-url>")
		return false
	}
	return true
}
