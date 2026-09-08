package launcher

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestContainerPathsMatchTheImage gates a class of drift nothing else catches:
// the launcher mounts a host directory ONTO a container path, and the gateway
// image declares that same path in an ENV so the app knows where to look. Two
// literals, in two languages, in two files, and no compiler that can see both.
//
// Drift is silent in the worst way. The mount still succeeds — every runtime
// creates the target if it is absent — so the stack boots clean and the app
// reads an empty directory forever. For the anchored-text store that surfaces
// as "OCR got slow again", months later, with nothing in any log to explain it.
//
// Reading the Dockerfile from a Go test crosses a module boundary deliberately:
// the coupling is real and spans both sides, so a check that does not span it
// would only assert one side against a copy of itself.
// declaredEnv parses one Dockerfile's ENV lines. Reading them from a Go test
// crosses a module boundary deliberately: the coupling is real and spans both
// sides, so a check that does not span it would only assert one side against a
// copy of itself.
func declaredEnv(t *testing.T, parts ...string) map[string]string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(parts...))
	if err != nil {
		t.Fatalf("reading %s: %v", filepath.Join(parts...), err)
	}
	declared := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		rest, ok := strings.CutPrefix(strings.TrimSpace(line), "ENV ")
		if !ok {
			continue
		}
		if name, value, ok := strings.Cut(rest, "="); ok {
			declared[strings.TrimSpace(name)] = strings.Trim(strings.TrimSpace(value), `"`)
		}
	}
	if len(declared) == 0 {
		t.Fatalf("parsed no ENV lines out of %s — the parser, not the paths, is what broke", filepath.Join(parts...))
	}
	return declared
}

func TestContainerPathsMatchTheImage(t *testing.T) {
	// Each row: an image, the ENV it uses to find something, and the container
	// path the launcher mounts onto for it. The row belongs to whichever image
	// MOUNTS the store — anchored-text moved from the gateway to the Smelter
	// with the mount and the stamp (ANCHORED-TEXT-TO-SMELTER P4/P5), and the
	// Smelter was declaring no such ENV while `smelter-main` refused to boot
	// without it. Add a row whenever a mount gains an ENV; move one whenever a
	// mount moves.
	for _, c := range []struct {
		label  string
		file   []string
		env    string
		mounts string
	}{
		// The KB tree's row moved from the gateway to the ARCHIVIST with the
		// mount itself (SINGLE-KB-MOUNT P6): the gateway declares neither of
		// these env vars now, because it mounts nothing they could name.
		{"archivist", []string{"..", "..", "..", "archivist", "Dockerfile"},
			"SEMIONT_ROOT", kbMountTarget},
		{"smelter", []string{"..", "..", "..", "smelter", "Dockerfile"},
			"SEMIONT_ANCHORED_TEXT_DIR", stateStores["anchored-text"].mounts[0].target},
	} {
		declared := declaredEnv(t, c.file...)
		got, ok := declared[c.env]
		if !ok {
			t.Errorf("the %s image declares no %s, but the launcher mounts onto %s expecting it", c.label, c.env, c.mounts)
			continue
		}
		if got != c.mounts {
			t.Errorf("%s/%s: the image says %q, the launcher mounts onto %q — the service would read an empty directory and never report it",
				c.label, c.env, got, c.mounts)
		}
	}
}

// THE WHOLE PLAN'S GATE (SINGLE-KB-MOUNT): exactly one container bind-mounts
// the knowledge base tree.
//
// Asserted on the run arguments the launcher BUILDS, not observed on a running
// stack — an observation passes for whatever happens to be up, while this fails
// the moment someone re-adds a mount, which is the only way the property is
// ever lost.
func TestExactlyOneContainerMountsTheKB(t *testing.T) {
	const kbRoot = "/host/kb"
	mount := kbRoot + ":" + kbMountTarget

	// Every builder that could plausibly want the tree, with the arguments a
	// real start passes. `archivistArgs` is the one that takes a kbRoot at all
	// now — the others cannot mount it because they are not given it, which is
	// the property expressed in the signatures themselves.
	fleet := map[string][]string{
		"gateway":   gatewayArgs("/stage", "1.2.3.4", "secret", "jwt", "v", 4000, nil, nil),
		"archivist": archivistArgs(kbRoot, "/stage", "1.2.3.4", "secret", "v", nil, nil),
		"librarian": librarianArgs("/stage", "1.2.3.4", "secret", "v", nil, nil),
		"worker":    sidecarArgs("worker", 24100, "/stage", "1.2.3.4", "secret", "v", nil, nil),
		"smelter":   sidecarArgs("smelter", 24101, "/stage", "1.2.3.4", "secret", "v", nil, nil),
		"weaver":    sidecarArgs("weaver", 24102, "/stage", "1.2.3.4", "secret", "v", nil, nil),
	}

	var mounters []string
	for svc, args := range fleet {
		for _, a := range args {
			if strings.Contains(a, kbMountTarget) && strings.Contains(a, kbRoot) {
				mounters = append(mounters, svc)
				break
			}
		}
	}

	if len(mounters) != 1 || mounters[0] != "archivist" {
		t.Fatalf("containers mounting %s = %v, want exactly [archivist] — the tree has one owner", mount, mounters)
	}
}

// ARCHIVIST-STAYS-UP P1: the archivist restarts on crash and on hang — the
// only mechanism that can be true on all three runtimes (Apple container has
// no --restart at all; probed 2026-09-04). Supervision is a per-run opt-in
// now (ORCHESTRATOR-NATIVE-IMAGES D3: the launcher passes SEMIONT_SUPERVISE
// and boot.sh wraps the CMD), so this asserts the image half — the shared
// supervisor on board, parameterized for the archivist — against the files,
// never by running anything. The launcher half is
// TestStartOptsEveryServiceIntoSupervision.
func TestArchivistRunsUnderTheSupervisor(t *testing.T) {
	df, err := os.ReadFile(filepath.Join("..", "..", "..", "archivist", "Dockerfile"))
	if err != nil {
		t.Fatalf("reading the archivist Dockerfile: %v", err)
	}
	for what, want := range map[string]string{
		"the shared supervisor":              "scripts/container/supervise.sh",
		"the boot entrypoint that arms it":   "scripts/container/boot.sh",
		"the entry point, stated once (CMD)": "dist/archivist-main.js",
		"the supervisor's probe target":      "SUPERVISE_PROBE=http://localhost:24103/health",
	} {
		if !strings.Contains(string(df), want) {
			t.Errorf("the archivist Dockerfile is missing %s (expected to find %q) — a crashed or hung Archivist stays down, and its absence looks like a frontend hang", what, want)
		}
	}
	sup, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "scripts", "container", "supervise.sh"))
	if err != nil {
		t.Fatalf("reading supervise.sh: %v", err)
	}
	s := string(sup)
	for what, want := range map[string]string{
		"a durable log on the state mount":     "/semiont-state/",
		"a TERM trap (semiont stop wins)":      "trap",
		"a rapid-failure cap (fail-fast boot)": "MAX_RAPID",
		"the env-driven health self-probe":     "SUPERVISE_PROBE",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("supervise.sh is missing %s (expected to find %q)", what, want)
		}
	}
}

// Each service's health port is hand-written in five homes (TS main const,
// Dockerfile EXPOSE, Dockerfile HEALTHCHECK, Dockerfile SUPERVISE_PROBE,
// launcher portNeed). They can't be derived across three languages, so this
// gate keeps them agreeing.
func TestServiceHealthPortsAgreeAcrossAllHomes(t *testing.T) {
	mains := map[string]string{
		"worker":    filepath.Join("..", "..", "..", "..", "packages", "jobs", "src", "worker-main.ts"),
		"smelter":   filepath.Join("..", "..", "..", "..", "packages", "make-meaning", "src", "smelter-main.ts"),
		"weaver":    filepath.Join("..", "..", "..", "..", "packages", "make-meaning", "src", "weaver-main.ts"),
		"archivist": filepath.Join("..", "..", "..", "..", "packages", "make-meaning", "src", "archivist-main.ts"),
		"librarian": filepath.Join("..", "..", "..", "..", "packages", "make-meaning", "src", "librarian-main.ts"),
	}
	tsPort := regexp.MustCompile(`const healthPort = (\d+)`)
	exposePort := regexp.MustCompile(`(?m)^EXPOSE (\d+)`)
	healthURL := regexp.MustCompile(`localhost:(\d+)/health`)
	probeURL := regexp.MustCompile(`SUPERVISE_PROBE=http://localhost:(\d+)/health`)
	for svc, mainPath := range mains {
		want := roles[svc].ports[0].port

		ts, err := os.ReadFile(mainPath)
		if err != nil {
			t.Fatalf("%s: reading %s: %v", svc, mainPath, err)
		}
		m := tsPort.FindSubmatch(ts)
		if m == nil {
			t.Errorf("%s: no `const healthPort = N` in its main — the gate cannot see its port", svc)
		} else if got := string(m[1]); got != fmt.Sprint(want) {
			t.Errorf("%s: TS healthPort %s != launcher portNeed %d", svc, got, want)
		}

		df, err := os.ReadFile(filepath.Join("..", "..", "..", svc, "Dockerfile"))
		if err != nil {
			t.Fatalf("%s: reading Dockerfile: %v", svc, err)
		}
		if m := exposePort.FindSubmatch(df); m == nil || string(m[1]) != fmt.Sprint(want) {
			t.Errorf("%s: Dockerfile EXPOSE disagrees with launcher portNeed %d", svc, want)
		}
		if m := healthURL.FindSubmatch(df); m == nil || string(m[1]) != fmt.Sprint(want) {
			t.Errorf("%s: Dockerfile HEALTHCHECK URL disagrees with launcher portNeed %d", svc, want)
		}
		if m := probeURL.FindSubmatch(df); m == nil || string(m[1]) != fmt.Sprint(want) {
			t.Errorf("%s: Dockerfile SUPERVISE_PROBE disagrees with launcher portNeed %d — the supervisor would probe the wrong port and kill a healthy child", svc, want)
		}
	}
}
