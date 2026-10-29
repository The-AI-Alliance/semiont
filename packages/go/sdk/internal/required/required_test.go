package required

import (
	"encoding/json"
	"reflect"
	"slices"
	"testing"
)

// shape is as the generator writes a schema's object: an optional member with
// omitempty, a member that may be null as a pointer.
type shape struct {
	Name     string   `json:"name"`
	Nickname *string  `json:"nickname"`
	Tags     []string `json:"tags,omitempty"`
	Skipped  string   `json:"-"`
}

func object(t *testing.T, text string) map[string]json.RawMessage {
	t.Helper()
	var read map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &read); err != nil {
		t.Fatal(err)
	}
	return read
}

func TestWhatATypeRequiresIsWhatItsTagsWriteWithoutOmitempty(t *testing.T) {
	if got := Of(reflect.TypeFor[shape]()); !slices.Equal(got, []string{"name", "nickname"}) {
		t.Errorf("shape requires %v", got)
	}
}

func TestAMemberThatIsMissingOrNullWhereItMayNotBeIsLacking(t *testing.T) {
	generated := reflect.TypeFor[shape]()
	for text, want := range map[string]string{
		`{"nickname":null}`:                       "name",
		`{"name":null,"nickname":"n"}`:            "name",
		`{"name":"a"}`:                            "nickname",
		`{"name":"a","nickname":null}`:            "",
		`{"name":"a","nickname":"n"}`:             "",
		`{"name":"a","nickname":"n","tags":null}`: "",
	} {
		name, lacks := Lacking(object(t, text), generated)
		if lacks != (want != "") || name != want {
			t.Errorf("%s lacks %q (%v), not %q", text, name, lacks, want)
		}
	}
}

func TestAPayloadIsReadAsATypeOnlyWhenItCarriesWhatTheTypeRequires(t *testing.T) {
	if read, ok := ReadAs[shape]([]byte(`{"name":"a","nickname":null}`)); !ok || read.Name != "a" {
		t.Errorf("a payload with what shape requires reads as %+v, %v", read, ok)
	}
	for _, text := range []string{`{"name":"a"}`, `"a"`, `null`, `[]`, `{"name":null,"nickname":null}`} {
		if _, ok := ReadAs[shape]([]byte(text)); ok {
			t.Errorf("%s is read as a shape", text)
		}
	}
}
