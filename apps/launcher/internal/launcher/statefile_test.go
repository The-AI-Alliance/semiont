package launcher

import (
	"os"
	"path/filepath"
	"testing"
)

// statefile_test.go — the record is either read or refused, never silently
// reduced to "this machine has no stacks".
//
// An empty stack set is an ANSWER, not the absence of one, and it is the one
// answer that costs a user a running stack: stop finds nothing to stop, status
// shows nothing, the containers and the codespace keep running. So a file that
// exists and cannot be turned into stacks must arrive carrying why.

// recordPath isolates the state home (stateHome, importcmd_test.go) and
// returns the stack.json path inside it — derived from statePath, so the test
// follows the launcher to whichever home this platform uses.
func recordPath(t *testing.T) string {
	t.Helper()
	stateHome(t)
	p := statePath()
	if p == "" {
		t.Fatal("no state path with HOME set")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestAbsentRecordIsACleanEmptySet(t *testing.T) {
	recordPath(t) // nothing written
	ss := LoadStackSet()
	if ss.unreadable != nil {
		t.Errorf("an absent record is the clean state, not a failure: %v", ss.unreadable)
	}
	if len(ss.Stacks) != 0 {
		t.Errorf("stacks = %v, want none", ss.Stacks)
	}
}

// An empty set with a Browser record is what survives a full stop — valid,
// and the reason "no stacks" cannot simply mean "unreadable".
func TestEmptySetWithABrowserRecordIsReadable(t *testing.T) {
	p := recordPath(t)
	body := `{"schema":3,"stacks":{},"browser":{"id":"bid","endpoint":"http://localhost:3000"}}`
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	ss := LoadStackSet()
	if ss.unreadable != nil {
		t.Fatalf("a stopped machine's record refused: %v", ss.unreadable)
	}
	if ss.Browser == nil || ss.Browser.ID != "bid" {
		t.Errorf("browser record lost: %+v", ss.Browser)
	}
}

func TestUnreadableRecordIsNotAnEmptySet(t *testing.T) {
	// Each of these EXISTS and cannot be turned into stacks. The first is the
	// realistic one: a record written before the codespace placement became a
	// nested object still carries the instance name as a plain string there,
	// so the whole set fails to unmarshal — and every stack in it, including
	// the codespace nothing sweeps by name, would vanish from the launcher's
	// view.
	for _, tc := range []struct{ name, body string }{
		{"pre-placement codespace record", `{"schema":3,"stacks":{"codespace:owner/kb":{` +
			`"runtime":"codespace","codespace":"cs-1","repo":"owner/kb",` +
			`"forwardPort":4000,"services":{}}}}`},
		{"truncated file", `{"schema":3,"stacks":{"local":{"runtime":"container"`},
		{"not json at all", "half a log line\n"},
		{"stacks is not an object", `{"schema":3,"stacks":[]}`},
		{"stacks is null", `{"schema":3,"stacks":null}`},
		{"schema 1", `{"schema":1,"runtime":"container","services":{}}`},
		{"schema 2 without services", `{"schema":2,"runtime":"container"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := recordPath(t)
			if err := os.WriteFile(p, []byte(tc.body), 0o644); err != nil {
				t.Fatal(err)
			}
			ss := LoadStackSet()
			if ss.unreadable == nil {
				t.Fatalf("read as %d stack(s) with no complaint — an unreadable record became \"no stacks recorded\"", len(ss.Stacks))
			}
			if !ss.refuseUnreadable(NewUI(false)) {
				t.Error("refuseUnreadable did not refuse a record it could not read")
			}
		})
	}
}

func TestSaveNeverOverwritesAnUnreadableRecord(t *testing.T) {
	// The file the launcher could not parse is the only evidence of what may
	// still be running. A save that replaced it with the one stack this
	// process happens to know about would destroy that evidence.
	p := recordPath(t)
	body := `{"schema":3,"stacks":{"codespace:owner/kb":{"codespace":"cs-1","services":{}}}}`
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	saveStack(&StackState{Runtime: "container", Services: map[string]ServiceState{}})
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("record removed: %v", err)
	}
	if string(b) != body {
		t.Errorf("unreadable record overwritten:\n%s", b)
	}
}
