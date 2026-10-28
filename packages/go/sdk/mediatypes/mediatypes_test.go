package mediatypes

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

// registry is specs/src/media-types/registry.json, read by the test itself:
// the oracle is the registry, not the Go generated from it.
type registry struct {
	ExtensionAliases map[string]string `json:"extensionAliases"`
	TextSource       []string          `json:"textSource"`
	MediaTypes       []struct {
		MediaType  string `json:"mediaType"`
		Extension  string `json:"extension"`
		TextSource string `json:"textSource"`
		Authorable bool   `json:"authorable"`
	} `json:"mediaTypes"`
}

func readRegistry(t *testing.T) registry {
	t.Helper()
	b, err := os.ReadFile("../../../../specs/src/media-types/registry.json")
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

// Every row this package holds is the registry's, in its order, with what the
// rules read of it.
func TestTheRowsAreTheRegistrys(t *testing.T) {
	r := readRegistry(t)
	if len(Rows) != len(r.MediaTypes) {
		t.Fatalf("the generated table has %d rows, the registry %d", len(Rows), len(r.MediaTypes))
	}
	for i, stated := range r.MediaTypes {
		held := Rows[i]
		if held.MediaType != stated.MediaType || held.Extension != stated.Extension || string(held.TextSource) != stated.TextSource || held.Authorable != stated.Authorable {
			t.Errorf("row %d is %+v, and the registry states %+v", i, held, stated)
		}
	}
}

// The rules every SDK reads from the registry, as specs/src/media-types/cases.json
// states them.
type mediaTypeCases struct {
	CloneFormat []struct {
		Why    string  `json:"why"`
		Source *string `json:"source"`
		Format string  `json:"format"`
	} `json:"cloneFormat"`
	StorageFileName []struct {
		Why      string `json:"why"`
		Name     string `json:"name"`
		Format   string `json:"format"`
		FileName string `json:"fileName"`
	} `json:"storageFileName"`
	TextSource []map[string]any `json:"textSource"`
}

func readCases(t *testing.T) mediaTypeCases {
	t.Helper()
	b, err := os.ReadFile("../../../../specs/src/media-types/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	// Every section the table has is one this runner runs: a section it
	// gains is a rule this SDK is not yet held to, and fails here until it is.
	var sections map[string]json.RawMessage
	if err := json.Unmarshal(b, &sections); err != nil {
		t.Fatal(err)
	}
	// What a table says of who runs it is held by lint:spec-case-tables, and is no section.
	for section := range sections {
		if !slices.Contains([]string{"$comment", "runBy", "absent", "notYetReached", "cloneFormat", "storageFileName", "textSource"}, section) {
			t.Errorf("the table has a section %q, which this runner does not run", section)
		}
	}
	var cases mediaTypeCases
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases.CloneFormat) < 7 || len(cases.StorageFileName) < 7 || len(cases.TextSource) == 0 {
		t.Fatal("the table was not read: every test below would pass for the wrong reason")
	}
	return cases
}

func TestACloneTakesTheFormatTheTableSays(t *testing.T) {
	for _, stated := range readCases(t).CloneFormat {
		source := ""
		if stated.Source != nil {
			source = *stated.Source
		}
		if got := CloneFormat(source).MediaType; got != stated.Format {
			t.Errorf("%s: CloneFormat(%q) = %q, want %q", stated.Why, source, got, stated.Format)
		}
	}
}

func TestContentIsStoredUnderTheNameTheTableSays(t *testing.T) {
	for _, stated := range readCases(t).StorageFileName {
		format, ok := CapabilitiesOf(stated.Format)
		if !ok {
			t.Fatalf("%s: %s has no row", stated.Why, stated.Format)
		}
		if got := StorageFileName(stated.Name, format); got != stated.FileName {
			t.Errorf("%s: StorageFileName(%q) = %q, want %q", stated.Why, stated.Name, got, stated.FileName)
		}
		if got := StorageURI(stated.Name, format); got != "file://"+stated.FileName {
			t.Errorf("%s: StorageURI(%q) = %q, want file://%s", stated.Why, stated.Name, got, stated.FileName)
		}
	}
}

func TestWhereATypesTextComesFromAndWhatFollowsFromItAreWhatTheTableSays(t *testing.T) {
	r := readRegistry(t)
	seen := map[string]bool{}
	unlisted := map[string]bool{}
	parameters := false
	for _, stated := range readCases(t).TextSource {
		// A member this does not read would be a rule this SDK is not held to.
		for member := range stated {
			if !slices.Contains([]string{"why", "format", "textSource", "yieldsGeometry", "derivesText"}, member) {
				t.Errorf("a case states %q, which this runner does not read: %v", member, stated)
			}
		}
		why, _ := stated["why"].(string)
		format, ok := stated["format"].(string)
		source, okSource := stated["textSource"].(string)
		geometry, okGeometry := stated["yieldsGeometry"].(bool)
		derived, okDerived := stated["derivesText"].(bool)
		if !ok || !okSource || !okGeometry || !okDerived {
			t.Fatalf("%s: a case that does not state all three: %v", why, stated)
		}
		if got := TextSourceOf(format); string(got) != source {
			t.Errorf("%s: TextSourceOf(%q) = %q, want %q", why, format, got, source)
		}
		if got := YieldsGeometryOf(format); got != geometry {
			t.Errorf("%s: YieldsGeometryOf(%q) = %v, want %v", why, format, got, geometry)
		}
		if got := DerivesTextOf(format); got != derived {
			t.Errorf("%s: DerivesTextOf(%q) = %v, want %v", why, format, got, derived)
		}
		seen[source] = true
		if _, listed := CapabilitiesOf(format); !listed {
			unlisted[source] = true
		}
		parameters = parameters || format != BaseMediaType(format)
	}
	// What the cases must tell apart: each of the registry's words, each
	// answer for a type the registry lacks, and a format from its parameters
	// and its case.
	for _, word := range r.TextSource {
		if !seen[word] {
			t.Errorf("no case's text source is %q, one of the registry's words", word)
		}
	}
	if !unlisted[string(TextSourceDecode)] || !unlisted[string(TextSourceNone)] || len(unlisted) != 2 {
		t.Errorf("the cases of types the registry lacks answer %v, and must answer decode and none", unlisted)
	}
	if !parameters {
		t.Error("no case's format has parameters or another case")
	}
}

// Every word the registry has for where a text comes from is one this
// package names and each rule answers, and each is some row's.
func TestEveryTextSourceIsTheRegistrysAndEachRuleAnswersIt(t *testing.T) {
	r := readRegistry(t)
	held := map[TextSource]bool{}
	for _, row := range Rows {
		held[row.TextSource] = true
	}
	if len(held) != len(r.TextSource) {
		t.Errorf("the rows have %d text sources, and the registry names %d", len(held), len(r.TextSource))
	}
	for _, word := range r.TextSource {
		if !held[TextSource(word)] {
			t.Errorf("the registry's text source %q is no row's", word)
		}
	}
	for _, row := range Rows {
		// Each rule answers each row's source, or panics naming it.
		YieldsGeometryOf(row.MediaType)
		DerivesTextOf(row.MediaType)
	}
}

func TestAFormatIsReadWithoutItsParametersAndInLowerCase(t *testing.T) {
	if got := BaseMediaType("Text/HTML; charset=utf-8"); got != "text/html" {
		t.Errorf("BaseMediaType = %q, want text/html", got)
	}
	if row, ok := CapabilitiesOf(" text/markdown ;charset=utf-8"); !ok || row.Extension != ".md" {
		t.Errorf("CapabilitiesOf = (%+v, %v), want the markdown row", row, ok)
	}
}
