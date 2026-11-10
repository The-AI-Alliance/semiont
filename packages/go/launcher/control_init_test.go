package launcher

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const (
	controlInitHelperEnv = "SEMIONT_CONTROL_INIT_HELPER"
	controlInitRecordEnv = "SEMIONT_CONTROL_INIT_RECORD"
)

type controlInitHelperRecord struct {
	Args      []string `json:"args"`
	Directory string   `json:"directory"`
	RootEnv   string   `json:"rootEnv"`
	Preserved string   `json:"preserved"`
}

// TestControlInitHelper is re-executed as the fake launcher executable. It
// captures the command and emits output through the same subprocess pipes as
// `semiont init` would.
func TestControlInitHelper(t *testing.T) {
	if os.Getenv(controlInitHelperEnv) != "1" {
		return
	}

	args := os.Args
	for index, arg := range args {
		if arg == "--" {
			args = args[index+1:]
			break
		}
	}
	directory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	record := controlInitHelperRecord{
		Args: args, Directory: directory,
		RootEnv: os.Getenv("SEMIONT_ROOT"), Preserved: os.Getenv("CONTROL_INIT_TEST_ENV"),
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv(controlInitRecordEnv), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	_, _ = os.Stdout.WriteString(os.Getenv("CONTROL_INIT_STDOUT"))
	_, _ = os.Stderr.WriteString(os.Getenv("CONTROL_INIT_STDERR"))
	if code := os.Getenv("CONTROL_INIT_EXIT"); code != "" && code != "0" {
		os.Exit(9)
	}
}

func controlInitParamsJSON(t *testing.T, p ControlRootsInitParams) []byte {
	t.Helper()
	encoded, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func controlInitRequest(ctx context.Context, p ControlRootsInitParams) *controlRequest {
	return &controlRequest{ctx: ctx, method: controlMethod{name: "roots.init"}, params: controlInitParamsJSONForRequest(p)}
}

func controlInitParamsJSONForRequest(p ControlRootsInitParams) json.RawMessage {
	encoded, _ := json.Marshal(p)
	return encoded
}

func controlInitUI() (*UI, *[]string) {
	var lines []string
	refused := &refusal{}
	return &UI{said: func(_ string, line string) { lines = append(lines, line) }, refused: refused}, &lines
}

func controlInitCommand(t *testing.T) (func(context.Context, string, ...string) *exec.Cmd, string) {
	t.Helper()
	recordPath := filepath.Join(t.TempDir(), "init.json")
	t.Setenv(controlInitHelperEnv, "1")
	t.Setenv(controlInitRecordEnv, recordPath)
	t.Setenv("CONTROL_INIT_TEST_ENV", "preserved")
	t.Setenv("SEMIONT_ROOT", "must-not-be-inherited")
	return func(ctx context.Context, _ string, args ...string) *exec.Cmd {
		helperArgs := append([]string{"-test.run=^TestControlInitHelper$", "--"}, args...)
		return exec.CommandContext(ctx, os.Args[0], helperArgs...)
	}, recordPath
}

func TestControlRootsInitRunsLauncherInitWithConfiguredFlags(t *testing.T) {
	root := t.TempDir()
	command, recordPath := controlInitCommand(t)
	name, siteName, inference, model := "Research KB", "Research", "ollama", "llama3"
	modelLight, embedding, configName := "llama3:lite", "nomic-embed-text", "ollama-local"
	endpoint, ollamaBase, registry := "https://api.example.test", "http://localhost:11434", "registry.example.test"
	p := ControlRootsInitParams{
		ApiVersion: controlAPIVersion, Path: root, Domain: "owner.github.io:research",
		Name: &name, SiteName: &siteName, Inference: &inference, Model: &model, ModelLight: &modelLight,
		Embedding: &embedding, ConfigName: &configName, AnthropicEndpoint: &endpoint,
		OllamaBase: &ollamaBase, OllamaRegistry: &registry,
	}
	u, lines := controlInitUI()
	result, failure := controlRootsInitWith(
		controlInitRequest(context.Background(), p), u, os.Executable, command,
	)
	if failure != nil {
		t.Fatalf("init failed: %+v", failure)
	}
	if result != (ControlRootsInitResult{Path: root}) {
		t.Fatalf("result = %#v", result)
	}

	encoded, err := os.ReadFile(recordPath)
	if err != nil {
		t.Fatal(err)
	}
	var record controlInitHelperRecord
	if err := json.Unmarshal(encoded, &record); err != nil {
		t.Fatal(err)
	}
	wantArgs := []string{
		"init", "--yes", "--domain", p.Domain,
		"--name", name, "--site-name", siteName, "--inference", inference,
		"--model", model, "--model-light", modelLight,
		"--embedding", "ollama:" + embedding, "--config-name", configName,
		"--anthropic-endpoint", endpoint, "--ollama-base", ollamaBase,
		"--ollama-registry", registry,
	}
	if !reflect.DeepEqual(record.Args, wantArgs) {
		t.Fatalf("launcher args = %#v, want %#v", record.Args, wantArgs)
	}
	if record.Directory != root || record.RootEnv != "" || record.Preserved != "preserved" {
		t.Fatalf("launcher environment = %+v", record)
	}
	if !strings.Contains(strings.Join(*lines, "\n"), "Creating local knowledge base") {
		t.Fatalf("progress did not include the initial message: %v", *lines)
	}
}

func TestControlRootsInitValidatesPathAndExecutable(t *testing.T) {
	ctx := context.Background()
	for _, test := range []struct {
		name string
		path string
	}{
		{name: "relative", path: "relative/path"},
		{name: "missing", path: filepath.Join(t.TempDir(), "missing")},
		{name: "not a directory", path: filepath.Join(t.TempDir(), "file")},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.name == "not a directory" {
				if err := os.WriteFile(test.path, []byte("x"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			u, _ := controlInitUI()
			p := ControlRootsInitParams{Path: test.path, Domain: "example.test"}
			_, failure := controlRootsInitWith(controlInitRequest(ctx, p), u, os.Executable,
				func(context.Context, string, ...string) *exec.Cmd { t.Fatal("must not execute"); return nil })
			if failure == nil || failure.code != controlCodeInvalidRequest {
				t.Fatalf("failure = %+v, want invalid request", failure)
			}
		})
	}

	root := t.TempDir()
	u, _ := controlInitUI()
	_, failure := controlRootsInitWith(
		controlInitRequest(ctx, ControlRootsInitParams{Path: root, Domain: "example.test"}),
		u,
		func() (string, error) { return "", errors.New("no executable") },
		func(context.Context, string, ...string) *exec.Cmd { t.Fatal("must not execute"); return nil },
	)
	if failure == nil || failure.code != controlCodeFailed || !strings.Contains(failure.message, "no executable") {
		t.Fatalf("failure = %+v, want executable lookup failure", failure)
	}
}

func TestControlRootsInitDecodesParamsAndReportsFailures(t *testing.T) {
	root := t.TempDir()
	u, _ := controlInitUI()
	req := controlInitRequest(context.Background(), ControlRootsInitParams{Path: root})
	req.params = json.RawMessage(`{"path":5}`)
	if _, failure := controlRootsInitWith(req, u, os.Executable, exec.CommandContext); failure == nil || failure.code != controlCodeInvalidParams {
		t.Fatalf("decode failure = %+v, want invalid params", failure)
	}
	if _, failure := controlRootsInit(req, u); failure == nil || failure.code != controlCodeInvalidParams {
		t.Fatalf("registered handler failure = %+v, want invalid params", failure)
	}

	command, _ := controlInitCommand(t)
	t.Setenv("CONTROL_INIT_EXIT", "1")
	t.Setenv("CONTROL_INIT_STDOUT", "preparing\n")
	t.Setenv("CONTROL_INIT_STDERR", "registry unavailable\n")
	u, lines := controlInitUI()
	p := ControlRootsInitParams{Path: root, Domain: "example.test"}
	_, failure := controlRootsInitWith(controlInitRequest(context.Background(), p), u, os.Executable, command)
	if failure == nil || failure.code != controlCodeFailed || !strings.Contains(failure.message, "registry unavailable") {
		t.Fatalf("failure = %+v, want captured launcher output", failure)
	}
	if !strings.Contains(strings.Join(*lines, "\n"), "preparing") || !strings.Contains(strings.Join(*lines, "\n"), "registry unavailable") {
		t.Fatalf("progress lines = %v", *lines)
	}

	u, _ = controlInitUI()
	_, failure = controlRootsInitWith(controlInitRequest(context.Background(), p), u, os.Executable,
		func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
			return exec.CommandContext(ctx, filepath.Join(root, "missing-launcher"))
		})
	if failure == nil || failure.code != controlCodeFailed || !strings.Contains(failure.message, "fork/exec") {
		t.Fatalf("failure = %+v, want process launch error", failure)
	}
}

func TestControlRootsInitCancellationAndOutputHelpers(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	u, _ := controlInitUI()
	p := ControlRootsInitParams{Path: root, Domain: "example.test"}
	_, failure := controlRootsInitWith(controlInitRequest(ctx, p), u, os.Executable, exec.CommandContext)
	if failure == nil || failure.code != controlCodeCancelled {
		t.Fatalf("failure = %+v, want cancellation", failure)
	}

	u, lines := controlInitUI()
	output := &controlInitOutput{ui: u}
	first, err := output.Write([]byte(" first \nsecond"))
	if err != nil || first != len(" first \nsecond") {
		t.Fatalf("first write = %d, %v", first, err)
	}
	_, _ = output.Write([]byte(" line\n  \n final "))
	output.finish()
	if got, want := output.String(), " first \nsecond line\n  \n final "; got != want {
		t.Fatalf("captured output = %q, want %q", got, want)
	}
	if !reflect.DeepEqual(*lines, []string{"first", "second line", "", "final"}) {
		t.Fatalf("logged lines = %#v", *lines)
	}

	if got := withoutSemiontRoot([]string{"A=1", "SEMIONT_ROOT=/wrong", "B=2", "SEMIONT_ROOT="}); !reflect.DeepEqual(got, []string{"A=1", "B=2"}) {
		t.Fatalf("filtered environment = %#v", got)
	}
}
