package launcher

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
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

// A value and its explanation are never one space apart: the value either
// leaves room in its column or sends the explanation to the next line. Width
// is counted in characters, as the column's padding is, so a value holding
// "←" is measured by what a person sees.
func TestSettingRowKeepsValueAndExplanationApart(t *testing.T) {
	u := &UI{}
	for _, width := range []int{1, settingValueWidth - 2, settingValueWidth - 1, settingValueWidth, settingValueWidth + 1, 200} {
		for _, value := range []string{strings.Repeat("v", width), "←" + strings.Repeat("v", width-1)} {
			got := settingRowText(u, "name", settingLine{value, "why"})
			rows := strings.Split(strings.TrimSuffix(got, "\n"), "\n")
			switch {
			case utf8.RuneCountInString(value) < settingValueWidth:
				if len(rows) != 1 || !strings.Contains(rows[0], value+"  ") || !strings.HasSuffix(rows[0], " why") {
					t.Errorf("width %d: a value that fits is printed as\n%q", width, got)
				}
			default:
				if len(rows) != 2 || !strings.HasSuffix(rows[0], value) || strings.TrimLeft(rows[1], " ") != "why" {
					t.Errorf("width %d: a wide value is printed as\n%q", width, got)
					continue
				}
				if at := utf8.RuneCountInString(rows[0]) - utf8.RuneCountInString(value); rows[1] != strings.Repeat(" ", at)+"why" {
					t.Errorf("width %d: the explanation is not under the value:\n%q", width, got)
				}
			}
		}
	}
}
