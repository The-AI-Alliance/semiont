package launcher

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
)

// lockedBuffer: a bytes.Buffer the server's goroutines write to at once.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) lines() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	text := strings.TrimSpace(l.b.String())
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

// codecServer: a control server whose answers go to a buffer. Its operation
// handlers are inert: this table tests request validation and response framing,
// not the machine state or side effects of each command.
func codecServer(t *testing.T) (*controlServer, *lockedBuffer) {
	t.Helper()
	schemas, err := compileControlSchemas()
	if err != nil {
		t.Fatalf("the control schemas do not compile: %v", err)
	}
	home, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	protocol := &lockedBuffer{}
	return &controlServer{protocol: protocol, diag: &lockedBuffer{}, schemas: schemas, home: home,
		inFlight: map[string]*controlRequest{}, drained: map[string]chan struct{}{}}, protocol
}

// validationServer: codecServer with harmless, schema-valid answers in place
// of command handlers. Request cases assert the protocol envelope, not command
// behavior or machine state.
func validationServer(t *testing.T) (*controlServer, *lockedBuffer) {
	t.Helper()
	s, protocol := codecServer(t)
	s.drainOutput = func() {}
	s.handlerFor = func(method string) controlHandler {
		return func(*controlRequest, *UI) (any, *controlFailure) {
			switch method {
			case "launcher.about":
				return ControlAboutResult{Development: true, ApiVersions: []string{controlAPIVersion}, ImageRegistry: imageRegistry, Runtimes: []ControlRuntimeState{}}, nil
			case "identity.useradd":
				return ControlIdentityUseraddResult{Email: "person@example.com", Identity: "did:web:example.com:users:1", Created: true}, nil
			case "identity.users.list":
				return ControlIdentityUsersListResult{Users: []ControlIdentityUser{}}, nil
			default:
				return map[string]any{}, nil
			}
		}
	}
	return s, protocol
}

type requestCase struct {
	Name   string `json:"name"`
	Line   string `json:"line"`
	Answer *struct {
		ID     json.RawMessage `json:"id"`
		Result bool            `json:"result"`
		Error  *struct {
			Code int `json:"code"`
			Data *struct {
				Code      string   `json:"code"`
				Retryable bool     `json:"retryable"`
				Fields    []string `json:"fields"`
				Supported []string `json:"supported"`
			} `json:"data"`
		} `json:"error"`
	} `json:"answer"`
}

// Each case of protocol/specs/src/control/request-cases.json: the line, sent
// to the launcher's codec, is answered as the case says.
func TestControlRequestCases(t *testing.T) {
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "specs", "src", "control", "request-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []requestCase `json:"cases"`
	}
	if err := json.Unmarshal(text, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("request-cases.json has no cases")
	}
	for _, c := range table.Cases {
		t.Run(c.Name, func(t *testing.T) {
			s, protocol := validationServer(t)
			s.receive([]byte(c.Line))
			s.handlers.Wait()
			lines := protocol.lines()
			if c.Answer == nil {
				if len(lines) != 0 {
					t.Fatalf("a notification was answered: %v", lines)
				}
				return
			}
			if len(lines) != 1 {
				t.Fatalf("answered with %d lines, want 1: %v", len(lines), lines)
			}
			var got struct {
				JSONRPC string          `json:"jsonrpc"`
				ID      json.RawMessage `json:"id"`
				Result  json.RawMessage `json:"result"`
				Error   *rpcError       `json:"error"`
			}
			if err := json.Unmarshal([]byte(lines[0]), &got); err != nil {
				t.Fatalf("the answer is not JSON: %v", err)
			}
			if got.JSONRPC != "2.0" {
				t.Errorf("jsonrpc = %q", got.JSONRPC)
			}
			if !jsonEqual(t, got.ID, c.Answer.ID) {
				t.Errorf("id = %s, want %s", got.ID, c.Answer.ID)
			}
			if c.Answer.Result {
				if got.Error != nil || len(got.Result) == 0 {
					t.Fatalf("answered %s, want a result", lines[0])
				}
				return
			}
			want := c.Answer.Error
			if got.Error == nil {
				t.Fatalf("answered %s, want error %d", lines[0], want.Code)
			}
			if got.Error.Code != want.Code {
				t.Errorf("error code %d, want %d (%s)", got.Error.Code, want.Code, got.Error.Message)
			}
			if want.Data == nil {
				if got.Error.Data != nil {
					t.Errorf("error data %+v, want none", got.Error.Data)
				}
				return
			}
			data := got.Error.Data
			if data == nil {
				t.Fatalf("no error data, want %s", want.Data.Code)
			}
			if data.Code != want.Data.Code || data.Retryable != want.Data.Retryable {
				t.Errorf("data %s retryable %v, want %s retryable %v", data.Code, data.Retryable, want.Data.Code, want.Data.Retryable)
			}
			var fields []string
			for _, f := range data.Fields {
				fields = append(fields, f.Field)
			}
			slices.Sort(fields)
			wantFields := slices.Clone(want.Data.Fields)
			slices.Sort(wantFields)
			if !slices.Equal(fields, wantFields) {
				t.Errorf("fields %v, want %v", fields, wantFields)
			}
			if !slices.Equal(data.Supported, want.Data.Supported) {
				t.Errorf("supported %v, want %v", data.Supported, want.Data.Supported)
			}
		})
	}
}

// jsonEqual: whether a and b are the same JSON value.
func jsonEqual(t *testing.T, a, b json.RawMessage) bool {
	t.Helper()
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		t.Fatalf("%s: %v", a, err)
	}
	if err := json.Unmarshal(b, &y); err != nil {
		t.Fatalf("%s: %v", b, err)
	}
	return reflect.DeepEqual(x, y)
}
