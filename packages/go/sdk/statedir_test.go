package semiont_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// The state home, as every program that finds tokens.json computes it
// (specs/src/sign-in-store/cases.json).
func TestTheStateHomeIsTheTables(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "specs", "src", "sign-in-store", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Why          string  `json:"why"`
			OS           string  `json:"os"`
			Home         *string `json:"home"`
			XDGStateHome *string `json:"xdgStateHome"`
			LocalAppData *string `json:"localAppData"`
			Dir          *string `json:"dir"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the table states no cases: this test would pass for the wrong reason")
	}
	// null in the table: not set, which "" is to StateDir.
	set := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	system := func(name string) semiont.System {
		switch name {
		case "macos":
			return semiont.SystemMacOS
		case "windows":
			return semiont.SystemWindows
		}
		return semiont.SystemOther
	}
	for _, c := range table.Cases {
		dir, ok := semiont.StateDir(system(c.OS), set(c.Home), set(c.XDGStateHome), set(c.LocalAppData))
		switch {
		case c.Dir == nil && ok:
			t.Errorf("%s: a state home %q, want none", c.Why, dir)
		case c.Dir != nil && !ok:
			t.Errorf("%s: no state home, want %q", c.Why, *c.Dir)
		case c.Dir != nil && dir != *c.Dir:
			t.Errorf("%s: the state home is %q, want %q", c.Why, dir, *c.Dir)
		}
	}
}
