package main_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// controlAPIVersion: the version the spec's ApiVersion.json fixes.
func controlAPIVersion(t *testing.T) string {
	t.Helper()
	text, err := os.ReadFile(filepath.Join(repoRoot(), "protocol", "specs", "src", "control", "ApiVersion.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Const string `json:"const"`
	}
	if err := json.Unmarshal(text, &schema); err != nil || schema.Const == "" {
		t.Fatalf("ApiVersion.json fixes no version: %s", text)
	}
	return schema.Const
}

// controlMessage: any line semiont control writes.
type controlMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	} `json:"error"`
}

// wireLog: what semiont control writes on stderr, kept for a failure to show.
type wireLog struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *wireLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *wireLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// controlClient: one semiont control process, spoken to a line at a time.
type controlClient struct {
	t          *testing.T
	apiVersion string
	stdin      io.WriteCloser
	stderr     *wireLog
	lines      chan string
	exited     chan error
	lastID     int
}

// fail ends the test with what semiont control wrote on stderr.
func (c *controlClient) fail(format string, a ...any) {
	c.t.Helper()
	c.t.Fatalf(format+"\nstderr:\n%s", append(a, c.stderr)...)
}

func startControl(t *testing.T, s *scenario) *controlClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	t.Cleanup(cancel)
	cmd := s.command(ctx, "control")
	cmd.Stdin = nil
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr := &wireLog{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting semiont control: %v", err)
	}
	c := &controlClient{t: t, apiVersion: controlAPIVersion(t), stdin: stdin, stderr: stderr, lines: make(chan string), exited: make(chan error, 1)}
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 1<<20), 1<<24)
		for scanner.Scan() {
			c.lines <- scanner.Text()
		}
		close(c.lines)
		c.exited <- cmd.Wait()
	}()
	return c
}

// call sends method a request of params, apiVersion stated, and gives its
// result and the progress lines sent for it. Every line read on the way is a
// JSON-RPC 2.0 message.
func (c *controlClient) call(method string, params map[string]any) (json.RawMessage, []string) {
	c.t.Helper()
	c.lastID++
	id := c.lastID
	params["apiVersion"] = c.apiVersion
	line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if _, err := c.stdin.Write(append(line, '\n')); err != nil {
		c.fail("%s: writing the request: %v", method, err)
	}
	var progress []string
	deadline := time.After(5 * time.Minute)
	for {
		select {
		case <-deadline:
			c.fail("%s: no answer in five minutes; progress so far: %v", method, progress)
		case text, open := <-c.lines:
			if !open {
				c.fail("%s: semiont control ended before answering; progress: %v", method, progress)
			}
			var m controlMessage
			if err := json.Unmarshal([]byte(text), &m); err != nil || m.JSONRPC != "2.0" {
				c.fail("%s: semiont control wrote a line that is not a JSON-RPC message: %q", method, text)
			}
			if m.Method == "notifications/progress" {
				var p struct {
					RequestID int    `json:"requestId"`
					Kind      string `json:"kind"`
					Text      string `json:"text"`
				}
				if err := json.Unmarshal(m.Params, &p); err != nil {
					c.fail("%s: progress %s: %v", method, m.Params, err)
				}
				if p.RequestID != id {
					c.fail("%s: progress of request %d arrived after its answer: %s: %s", method, p.RequestID, p.Kind, p.Text)
				}
				progress = append(progress, p.Kind+": "+p.Text)
				continue
			}
			if m.Method != "" {
				continue
			}
			if string(m.ID) != itoa(id) {
				c.fail("%s: answered under id %s, want %d", method, m.ID, id)
			}
			if m.Error != nil {
				c.fail("%s: refused %d %s %s; progress: %v", method, m.Error.Code, m.Error.Message, m.Error.Data, progress)
			}
			return m.Result, progress
		}
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// end closes the server's stdin, which ends it, and gives how it exited.
func (c *controlClient) end() error {
	c.t.Helper()
	if err := c.stdin.Close(); err != nil {
		c.t.Fatal(err)
	}
	deadline := time.After(time.Minute)
	lines := c.lines
	for {
		select {
		case text, open := <-lines:
			if !open {
				lines = nil
				continue
			}
			c.t.Errorf("semiont control wrote %q after its last request was answered", text)
		case err := <-c.exited:
			return err
		case <-deadline:
			c.fail("semiont control did not end within a minute of its stdin closing")
		}
	}
}

type wireStatus struct {
	KnowledgeBases []struct {
		Key      string `json:"key"`
		Recorded bool   `json:"recorded"`
		Healthy  bool   `json:"healthy"`
		Starting bool   `json:"starting"`
	} `json:"knowledgeBases"`
	Shared []json.RawMessage `json:"shared"`
}

// A client drives a whole lifecycle over semiont control's stdio: what the
// launcher is, a start, the snapshot of the stack it started, a stop, and the
// snapshot after. Each operation's narration arrives as its progress, and
// nothing else reaches stdout but JSON-RPC messages; closing stdin ends the
// server cleanly.
func TestControlDrivesALifecycleOverStdio(t *testing.T) {
	s := newScenario(t, "container")
	c := startControl(t, s)

	about, _ := c.call("launcher.about", map[string]any{})
	var described struct {
		APIVersions []string `json:"apiVersions"`
	}
	if err := json.Unmarshal(about, &described); err != nil || !slices.Contains(described.APIVersions, c.apiVersion) {
		t.Errorf("launcher.about answered %s, which names no %s", about, c.apiVersion)
	}

	started, progress := c.call("stack.start", map[string]any{"runtime": "container"})
	var start struct {
		DryRun        bool `json:"dryRun"`
		KnowledgeBase *struct {
			Key     string `json:"key"`
			Healthy bool   `json:"healthy"`
		} `json:"knowledgeBase"`
	}
	if err := json.Unmarshal(started, &start); err != nil || start.DryRun || start.KnowledgeBase == nil || !start.KnowledgeBase.Healthy {
		t.Fatalf("stack.start answered %s, want the knowledge base healthy\nprogress: %v", started, progress)
	}
	if len(progress) == 0 {
		t.Error("stack.start sent no progress: a start narrates what it does")
	}

	snapshot, _ := c.call("status.snapshot", map[string]any{})
	var running wireStatus
	if err := json.Unmarshal(snapshot, &running); err != nil {
		t.Fatalf("status.snapshot answered %s: %v", snapshot, err)
	}
	if len(running.KnowledgeBases) != 1 || running.KnowledgeBases[0].Key != start.KnowledgeBase.Key ||
		!running.KnowledgeBases[0].Recorded || !running.KnowledgeBases[0].Healthy {
		t.Errorf("status.snapshot after the start answered %s, want the one knowledge base started, recorded and healthy", snapshot)
	}

	stopped, progress := c.call("stack.stop", map[string]any{})
	var stop struct {
		DryRun bool `json:"dryRun"`
	}
	if err := json.Unmarshal(stopped, &stop); err != nil || stop.DryRun {
		t.Errorf("stack.stop answered %s\nprogress: %v", stopped, progress)
	}

	after, _ := c.call("status.snapshot", map[string]any{})
	var quiet wireStatus
	if err := json.Unmarshal(after, &quiet); err != nil {
		t.Fatalf("status.snapshot answered %s: %v", after, err)
	}
	for _, kb := range quiet.KnowledgeBases {
		if kb.Healthy || kb.Starting {
			t.Errorf("status.snapshot after the stop answered %s, want nothing running", after)
		}
	}

	if err := c.end(); err != nil {
		t.Errorf("semiont control ended with %v when its stdin closed, want exit 0", err)
	}
}
