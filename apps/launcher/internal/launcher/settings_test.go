package launcher

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Every preference the launcher saves is a setting `semiont settings` lists,
// or is named as the registry's own bookkeeping (LAUNCHER-SETTINGS: the
// listing is a census). A field added to the registry without either fails
// here, so a new preference cannot be saved where no one can see it.
func TestEverySavedPreferenceIsASetting(t *testing.T) {
	covered := map[string]string{}
	for _, s := range settingsTable {
		for _, f := range s.saves {
			covered[f] = s.name
		}
	}
	for f := range registryBookkeeping {
		covered[f] = "bookkeeping"
	}
	for _, typ := range []reflect.Type{reflect.TypeOf(rootsRegistry{}), reflect.TypeOf(rootEntry{}), reflect.TypeOf(storeSettingsFile{})} {
		for i := range typ.NumField() {
			name := typ.Name() + "." + typ.Field(i).Name
			if _, ok := covered[name]; !ok {
				t.Errorf("%s is saved, but no setting lists it and it is not named as bookkeeping", name)
			}
			delete(covered, name)
		}
	}
	for f, by := range covered {
		t.Errorf("%s names %s, which no settings file has", by, f)
	}
}

// Nothing the launcher prints names the old verb: `secret` moved under
// `settings` (LAUNCHER-SETTINGS D2) with no alias, so a message that still
// says `semiont secret` sends a person to a command that does not exist.
func TestNoMessageNamesTheOldSecretVerb(t *testing.T) {
	var files []string
	for _, glob := range []string{"*.go", "../verbs/*.go", "../../main.go"} {
		m, err := filepath.Glob(glob)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, m...)
	}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(b), "\n") {
			if strings.Contains(line, "semiont secret") {
				t.Errorf("%s:%d names `semiont secret`: %s", f, i+1, strings.TrimSpace(line))
			}
		}
	}
}
