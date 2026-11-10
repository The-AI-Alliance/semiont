package launcher

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// controlRootsInit: initialize a local clone through semiont init itself, so
// the machine API and the command share one implementation of KB birth.
func controlRootsInit(req *controlRequest, u *UI) (any, *controlFailure) {
	return controlRootsInitWith(req, u, os.Executable, exec.CommandContext)
}

// controlRootsInitWith keeps process discovery and invocation injectable for
// tests without splitting the machine API's implementation from `semiont init`.
func controlRootsInitWith(
	req *controlRequest,
	u *UI,
	findExecutable func() (string, error),
	command func(context.Context, string, ...string) *exec.Cmd,
) (any, *controlFailure) {
	var p ControlRootsInitParams
	if f := req.decode(&p); f != nil {
		return nil, f
	}
	if !filepath.IsAbs(p.Path) {
		u.Fail("the knowledge base path must be absolute: %s", p.Path)
		return nil, failed(u, controlCodeInvalidRequest)
	}
	info, err := os.Stat(p.Path)
	if err != nil || !info.IsDir() {
		u.Fail("the knowledge base directory must already exist: %s", p.Path)
		return nil, failed(u, controlCodeInvalidRequest)
	}

	executable, err := findExecutable()
	if err != nil {
		u.Fail("cannot locate the launcher executable: %v", err)
		return nil, failed(u, controlCodeFailed)
	}
	args := []string{"init", "--yes", "--domain", p.Domain}
	add := func(flag string, value *string) {
		if value != nil {
			args = append(args, flag, *value)
		}
	}
	add("--name", p.Name)
	add("--site-name", p.SiteName)
	add("--inference", p.Inference)
	add("--model", p.Model)
	add("--model-light", p.ModelLight)
	if p.Embedding != nil {
		args = append(args, "--embedding", "ollama:"+*p.Embedding)
	}
	add("--config-name", p.ConfigName)
	add("--anthropic-endpoint", p.AnthropicEndpoint)
	add("--ollama-base", p.OllamaBase)
	add("--ollama-registry", p.OllamaRegistry)

	output := &controlInitOutput{ui: u}
	cmd := command(req.ctx, executable, args...)
	cmd.Dir = p.Path
	cmd.Env = withoutSemiontRoot(os.Environ())
	cmd.Stdout, cmd.Stderr = output, output
	u.Log("Creating local knowledge base in %s", p.Path)
	err = cmd.Run()
	output.finish()
	if err != nil {
		if req.ctx.Err() != nil {
			return nil, cancelledFailure(req)
		}
		message := strings.TrimSpace(output.String())
		if message == "" {
			message = err.Error()
		}
		u.Fail("semiont init failed: %s", message)
		return nil, failed(u, controlCodeFailed)
	}
	return ControlRootsInitResult{Path: p.Path}, nil
}

func withoutSemiontRoot(env []string) []string {
	result := make([]string, 0, len(env))
	for _, entry := range env {
		if !strings.HasPrefix(entry, "SEMIONT_ROOT=") {
			result = append(result, entry)
		}
	}
	return result
}

// controlInitOutput turns each line semiont init prints into a live progress
// notice, while retaining the output for a useful structured failure.
type controlInitOutput struct {
	mu      sync.Mutex
	ui      *UI
	pending string
	output  strings.Builder
}

func (w *controlInitOutput) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, _ = w.output.Write(p)
	w.pending += string(p)
	for index := strings.IndexByte(w.pending, '\n'); index >= 0; index = strings.IndexByte(w.pending, '\n') {
		w.ui.Log("%s", strings.TrimSpace(w.pending[:index]))
		w.pending = w.pending[index+1:]
	}
	return len(p), nil
}

func (w *controlInitOutput) finish() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if line := strings.TrimSpace(w.pending); line != "" {
		w.ui.Log("%s", line)
	}
	w.pending = ""
}

func (w *controlInitOutput) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.output.String()
}
