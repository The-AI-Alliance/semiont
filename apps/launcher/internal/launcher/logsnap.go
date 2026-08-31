package launcher

// logsnap.go — crash evidence at the two moments it would otherwise die.
// The runtime's log capture is the ONLY copy of a stack's stdout story
// (services log to stdout; nothing writes files — STATE-MAP.md), and both
// teardown paths delete it: `semiont stop` and the start preflight rm every
// container. So: every teardown snapshots the capture into the root's state
// area first, and every `run` bounds the capture so a long-lived stack
// cannot grow it without limit.

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// snapshotKeep bounds how many teardown snapshots a root retains under
// <stateRootDir>/logs/ — one timestamped dir per teardown, oldest pruned.
const snapshotKeep = 5

// logOptArgs: per-runtime `run` arguments bounding the container log
// capture. Docker's json-file driver rotates (max-size + max-file);
// podman's k8s-file driver knows only max-size; Apple `container` has no
// log options — its capture is the runtime's own affair.
func logOptArgs(rt string) []string {
	switch rt {
	case "docker":
		return []string{"--log-opt", "max-size=10m", "--log-opt", "max-file=3"}
	case "podman":
		return []string{"--log-opt", "max-size=10m"}
	}
	return nil
}

// withLogOpts injects logOptArgs into a `run` argv, right after the
// subcommand. One decider for both executors: liveExec runs the result and
// planExec prints it, so --dry-run shows exactly what a real start runs.
func withLogOpts(rt string, args []string) []string {
	opts := logOptArgs(rt)
	if len(opts) == 0 || len(args) == 0 || args[0] != "run" {
		return args
	}
	out := make([]string, 0, len(args)+len(opts))
	out = append(out, args[0])
	out = append(out, opts...)
	out = append(out, args[1:]...)
	return out
}

// logsReadArgs: docker/podman bound the read so a snapshot stays a story,
// not an archive; Apple `container` takes no tail flag.
func logsReadArgs(rt, name string) []string {
	if rt == "docker" || rt == "podman" {
		return []string{"logs", "--tail", "5000", name}
	}
	return []string{"logs", name}
}

// writeLogSnapshot writes each container's retained stdout/stderr to
// <stateRootDir(root)>/logs/<timestamp>/<name>.log. Best-effort by design:
// an absent container, an empty capture, or a homeless root skips silently —
// a snapshot must never block a teardown. Returns the snapshot dir and how
// many files were written ("" and 0 when nothing was).
func writeLogSnapshot(rt, root string, names []string) (string, int) {
	base := stateRootDir(root)
	if root == "" || base == "" {
		return "", 0
	}
	dir := filepath.Join(base, "logs", time.Now().UTC().Format("20060102-150405Z"))
	written := 0
	for _, name := range names {
		out, err := captureBoth(rt, logsReadArgs(rt, name)...)
		if err != nil || strings.TrimSpace(out) == "" {
			continue
		}
		if written == 0 {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return "", 0
			}
		}
		if os.WriteFile(filepath.Join(dir, name+".log"), []byte(out), 0o644) == nil {
			written++
		}
	}
	if written == 0 {
		return "", 0
	}
	pruneSnapshots(filepath.Join(base, "logs"), snapshotKeep)
	return dir, written
}

// pruneSnapshots keeps the newest `keep` snapshot dirs. Timestamp names
// sort lexically, so oldest-first is a plain sort.
func pruneSnapshots(logsDir string, keep int) {
	entries, err := os.ReadDir(logsDir)
	if err != nil {
		return
	}
	dirs := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		}
	}
	if len(dirs) <= keep {
		return
	}
	sort.Strings(dirs)
	for _, d := range dirs[:len(dirs)-keep] {
		_ = os.RemoveAll(filepath.Join(logsDir, d))
	}
}
