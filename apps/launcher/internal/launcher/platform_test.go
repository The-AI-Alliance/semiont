package launcher

import (
	"encoding/json"
	"strings"
	"testing"
)

// LAUNCHER-SERVICE-MODEL P3. "codespace" used to be one of the values of
// `Runtime`, beside container, docker and podman — so every reader of that
// field had to know that one of the runtimes was not a runtime, and the
// launcher refused each local-only flag by hand against that string.

// The refusals are the platform axis showing through the flag parser. They
// key off the platform now; every message and every accepted combination is
// unchanged, which is what start_args_test.go asserts.
func TestRuntimeFlagSplitsPlatformFromRuntime(t *testing.T) {
	opts, usage, refusal := parseStart([]string{"--runtime", "codespace", "--repo", "o/n"})
	if usage || refusal != "" {
		t.Fatalf("--runtime codespace --repo: usage=%v refusal=%q", usage, refusal)
	}
	if opts.platform != platformCodespace {
		t.Errorf("platform = %q, want codespace", opts.platform)
	}
	if opts.runtime != "" {
		t.Errorf("runtime = %q — a codespace start has no container runtime of ours; compose owns the services inside", opts.runtime)
	}

	opts, _, refusal = parseStart([]string{"--runtime", "docker"})
	if refusal != "" {
		t.Fatalf("--runtime docker refused: %s", refusal)
	}
	if opts.runtime != "docker" || opts.platform != platformLocal {
		t.Errorf("--runtime docker gave platform=%q runtime=%q, want local/docker", opts.platform, opts.runtime)
	}

	// A bare start declares no platform, and local is what "" means.
	opts, _, _ = parseStart(nil)
	if opts.platform != platformLocal {
		t.Errorf("a bare start is platform %q, want local", opts.platform)
	}
}

// The platform is the record's SHAPE, not a field beside it: a stack lives
// on a codespace exactly when it has a placement. Two fields could disagree;
// one cannot.
func TestPlatformIsDerivedFromThePlacement(t *testing.T) {
	local := &StackState{Runtime: "container"}
	if local.platform() != platformLocal {
		t.Errorf("a stack with no placement is %q, want local", local.platform())
	}
	if got := stackKey(local); got != "local" {
		t.Errorf("stackKey = %q, want local", got)
	}
	remote := &StackState{Codespace: &codespacePlacement{Name: "cs-1", Repo: "o/n", ForwardPort: 4000}}
	if remote.platform() != platformCodespace {
		t.Errorf("a stack with a placement is %q, want codespace", remote.platform())
	}
	if got := stackKey(remote); got != "codespace:o/n" {
		t.Errorf("stackKey = %q, want codespace:o/n", got)
	}
	// A codespace stack names no container runtime: there is none of ours.
	if remote.Runtime != "" {
		t.Errorf("Runtime = %q on a codespace stack", remote.Runtime)
	}
}

// The four placement facts travel together or not at all — a local record
// must not carry zeroed copies of them for every reader to test one by one.
func TestLocalRecordCarriesNoCodespaceFields(t *testing.T) {
	b, err := json.Marshal(&StackState{Runtime: "container", KBRoot: "/tmp/kb"})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"codespace", "repo", "forwardPid", "forwardPort"} {
		if strings.Contains(string(b), `"`+key+`"`) {
			t.Errorf("a local stack record carries %q: %s", key, b)
		}
	}
}

// The word "codespace" must not come back as a runtime value. This is the
// gate on the split: a new comparison against that string, anywhere a
// runtime is meant, is the conflation returning.
func TestNoRuntimeValueIsCodespace(t *testing.T) {
	for _, rt := range []string{"container", "docker", "podman"} {
		if p, isPlatform := runtimeFlagPlatform(rt); isPlatform {
			t.Errorf("%q reads as platform %q", rt, p)
		}
	}
	if p, isPlatform := runtimeFlagPlatform("codespace"); !isPlatform || p != platformCodespace {
		t.Errorf(`runtimeFlagPlatform("codespace") = %q,%v`, p, isPlatform)
	}
}
