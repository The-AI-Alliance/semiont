package launcher

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// declaredEnv parses one Dockerfile's ENV lines.
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

// TestContainerPathsMatchTheImage gates a class of drift nothing else catches:
// the launcher mounts a host directory ONTO a container path, and the mounting
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
func TestContainerPathsMatchTheImage(t *testing.T) {
	// Each row: an image, the ENV it uses to find something, and the container
	// path the launcher mounts onto for it. A row belongs to an image that
	// MOUNTS the store: anchored-text's is the Smelter, the store's writer and
	// the owner of its stamp, and `smelter-main` refuses to boot without the
	// ENV. Add a row whenever a mount gains an ENV; move one whenever a mount
	// moves.
	for _, c := range []struct {
		label  string
		file   []string
		env    string
		mounts string
	}{
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

// The Archivist's image names the KB mount twice — as git's one trusted
// directory, and as the directory the process starts in — and the launcher
// names it in the mount and in the document's `root`. git refuses a tree it
// was not told to trust, so a mismatch is an Archivist that cannot stage.
func TestTheArchivistImageTrustsTheKBMount(t *testing.T) {
	df, err := os.ReadFile(filepath.Join("..", "..", "..", "archivist", "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	for label, re := range map[string]*regexp.Regexp{
		"git's safe.directory": regexp.MustCompile(`safe\.directory (\S+)`),
		"WORKDIR":              regexp.MustCompile(`(?m)^WORKDIR (\S+)`),
	} {
		// The last one stated: the runtime stage's, after the builder's.
		all := re.FindAllSubmatch(df, -1)
		if len(all) == 0 {
			t.Errorf("the archivist image declares no %s", label)
		} else if got := string(all[len(all)-1][1]); got != kbMountTarget {
			t.Errorf("the archivist image's %s is %q, the launcher mounts the knowledge base onto %q", label, got, kbMountTarget)
		}
	}
}

// commandConfigPath: the path an image's exec-form CMD passes to --config.
func commandConfigPath(t *testing.T, parts ...string) string {
	t.Helper()
	df, err := os.ReadFile(filepath.Join(parts...))
	if err != nil {
		t.Fatal(err)
	}
	cmd := regexp.MustCompile(`(?m)^CMD (\[.*\])$`).FindSubmatch(df)
	if cmd == nil {
		t.Fatalf("%s has no exec-form CMD", filepath.Join(parts...))
	}
	var argv []string
	if err := json.Unmarshal(cmd[1], &argv); err != nil {
		t.Fatalf("%s: the CMD is not a JSON array: %v", filepath.Join(parts...), err)
	}
	for i, a := range argv {
		if a == "--config" && i+1 < len(argv) {
			return argv[i+1]
		}
	}
	return ""
}

// A service configured by a resolved document reads it from the path its
// image's command passes to --config, and the launcher mounts the document
// there. A mismatch is a service that refuses to start on every boot.
func TestConfigDocumentsAreWhereTheImagesLook(t *testing.T) {
	for _, c := range []struct {
		service string
		mounts  string
	}{
		{"gateway", gatewayDocumentTarget},
		{"dispatcher", dispatcherDocumentTarget},
		{"archivist", archivistDocumentTarget},
		{"worker", workerDocumentTarget},
	} {
		if named := commandConfigPath(t, "..", "..", "..", c.service, "Dockerfile"); named != c.mounts {
			t.Errorf("the %s image passes --config %q, the launcher mounts onto %q", c.service, named, c.mounts)
		}
	}
}

// THE GATE ON THE SINGLE KB MOUNT: exactly one container, the Archivist,
// bind-mounts the knowledge base tree.
//
// Asserted on the run arguments the launcher BUILDS, not observed on a running
// stack — an observation passes for whatever happens to be up, while this fails
// the moment someone adds a mount, which is the only way the property is
// ever lost.
func TestExactlyOneContainerMountsTheKB(t *testing.T) {
	const kbRoot = "/host/kb"
	mount := kbRoot + ":" + kbMountTarget

	// Every builder that could plausibly want the tree, with the arguments a
	// real start passes. `archivistArgs` is the only one that takes a kbRoot at
	// all — the others cannot mount it because they are not given it, which is
	// the property expressed in the signatures themselves.
	fleet := map[string][]string{
		"gateway":   gatewayArgs("/stage", "container", "1.2.3.4", "secret", "jwt", "v", 4000, nil, nil),
		"archivist": archivistArgs(kbRoot, "/stage", "container", "1.2.3.4", "client-secret", "v", nil, nil),
		"librarian": librarianArgs("/stage", "container", "1.2.3.4", "client-secret", "v", nil, nil),
		"worker":    workerArgs("/stage", "container", "1.2.3.4", "client-secret", "v", nil, nil),
		"smelter":   sidecarArgs("smelter", 24101, "/stage", "container", "1.2.3.4", "client-secret", "v", nil, nil),
		"weaver":    sidecarArgs("weaver", 24102, "/stage", "container", "1.2.3.4", "client-secret", "v", nil, nil),
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

// An in-container supervisor restarts the archivist on crash and on hang —
// the only mechanism that can be true on all three runtimes (Apple container
// has no --restart at all). Supervision is a per-run opt-in (the launcher
// passes SEMIONT_SUPERVISE and boot.sh wraps the CMD), so this asserts the
// image half — the shared supervisor on board, parameterized for the
// archivist — against the files, never by running anything. The launcher
// half is TestStartOptsEveryServiceIntoSupervision.
func TestArchivistRunsUnderTheSupervisor(t *testing.T) {
	df, err := os.ReadFile(filepath.Join("..", "..", "..", "archivist", "Dockerfile"))
	if err != nil {
		t.Fatalf("reading the archivist Dockerfile: %v", err)
	}
	for what, want := range map[string]string{
		"the shared supervisor":              "scripts/container/supervise.sh",
		"the boot entrypoint that arms it":   "scripts/container/boot.sh",
		"the entry point, stated once (CMD)": "/usr/local/bin/semiont-archivist",
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
// gate keeps them agreeing. The Archivist's main has no constant: it listens
// where its configuration document says, which the launcher writes from the
// portNeed. The dispatcher and the worker listen where theirs say too, and
// their images are held to the port those documents carry
// (TestDispatcherDocumentIsWhereTheImageLooks,
// TestWorkerDocumentIsWhereTheImageLooks).
func TestServiceHealthPortsAgreeAcrossAllHomes(t *testing.T) {
	mains := map[string]string{
		"smelter":   filepath.Join("..", "..", "..", "..", "packages", "make-meaning", "src", "smelter-main.ts"),
		"weaver":    filepath.Join("..", "..", "..", "..", "packages", "make-meaning", "src", "weaver-main.ts"),
		"archivist": "",
		"librarian": filepath.Join("..", "..", "..", "..", "packages", "make-meaning", "src", "librarian-main.ts"),
	}
	tsPort := regexp.MustCompile(`const healthPort = (\d+)`)
	exposePort := regexp.MustCompile(`(?m)^EXPOSE (\d+)`)
	healthURL := regexp.MustCompile(`localhost:(\d+)/health`)
	probeURL := regexp.MustCompile(`SUPERVISE_PROBE=http://localhost:(\d+)/health`)
	for svc, mainPath := range mains {
		want := semiontDescriptor(svc).ports[0].port

		if mainPath != "" {
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

// The census row above proves the image and the constant agree; this proves
// the gateway is actually mounted there — and that no other service is: each
// mounts its own document onto its own path.
func TestGatewayDocumentMountsOntoItsOwnPath(t *testing.T) {
	want := ":" + gatewayDocumentTarget + ":ro"
	if args := strings.Join(gatewayArgs("/stage", "container", "1.2.3.4", "secret", "jwt", "v", 4000, nil, nil), " "); !strings.Contains(args, want) {
		t.Errorf("the gateway's document is not mounted onto %s:\n%s", gatewayDocumentTarget, args)
	}
	for name, args := range map[string][]string{
		"archivist": archivistArgs("/kb", "/stage", "container", "1.2.3.4", "client-secret", "v", nil, nil),
		"worker":    workerArgs("/stage", "container", "1.2.3.4", "client-secret", "v", nil, nil),
	} {
		if strings.Contains(strings.Join(args, " "), gatewayDocumentTarget) {
			t.Errorf("%s mounts the gateway's document path", name)
		}
	}
}
