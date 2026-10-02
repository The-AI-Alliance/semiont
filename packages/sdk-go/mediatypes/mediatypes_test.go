package mediatypes

import (
	"encoding/json"
	"os"
	"testing"
)

// registry is specs/src/media-types/registry.json, read by the test itself:
// the oracle is the registry, not the Go generated from it.
type registry struct {
	ExtensionAliases map[string]string `json:"extensionAliases"`
	MediaTypes       []struct {
		MediaType string `json:"mediaType"`
		Extension string `json:"extension"`
	} `json:"mediaTypes"`
}

func readRegistry(t *testing.T) registry {
	t.Helper()
	b, err := os.ReadFile("../../../specs/src/media-types/registry.json")
	if err != nil {
		t.Fatal(err)
	}
	var r registry
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	if len(r.MediaTypes) == 0 {
		t.Fatal("the registry lists no media types")
	}
	return r
}

// An extension names the FIRST row that states it — the registry's rule for
// two types that share one — and every row and alias in the registry resolves.
func TestForExtensionFollowsTheRegistry(t *testing.T) {
	r := readRegistry(t)
	first := map[string]string{}
	for _, row := range r.MediaTypes {
		if _, seen := first[row.Extension]; !seen {
			first[row.Extension] = row.MediaType
		}
	}
	for ext, want := range first {
		if got, ok := ForExtension(ext); !ok || got != want {
			t.Errorf("ForExtension(%q) = (%q, %v), want %q", ext, got, ok, want)
		}
	}
	for alias, ext := range r.ExtensionAliases {
		if got, ok := ForExtension(alias); !ok || got != first[ext] {
			t.Errorf("ForExtension(%q) = (%q, %v), want %q, the type of %s", alias, got, ok, first[ext], ext)
		}
	}
	if len(Rows) != len(r.MediaTypes) {
		t.Errorf("the generated table has %d rows, the registry %d: regenerate with node scripts/spec/generate-media-types-go.mjs", len(Rows), len(r.MediaTypes))
	}
}

// The registry's own example of the order rule: the video rows are before the
// audio rows so that .webm is video.
func TestWebmIsVideo(t *testing.T) {
	if got, _ := ForExtension(".webm"); got != "video/webm" {
		t.Errorf(".webm is %q, want video/webm", got)
	}
}

// With or without its dot, in any case; and nothing for an extension no row
// states, so a caller chooses its own fallback.
func TestForExtensionSpellings(t *testing.T) {
	for _, ext := range []string{".md", "md", ".MD", " .Md "} {
		if got, ok := ForExtension(ext); !ok || got != "text/markdown" {
			t.Errorf("ForExtension(%q) = (%q, %v), want text/markdown", ext, got, ok)
		}
	}
	for _, ext := range []string{".xyz", "", "."} {
		if got, ok := ForExtension(ext); ok {
			t.Errorf("ForExtension(%q) = %q, want no type", ext, got)
		}
	}
}
