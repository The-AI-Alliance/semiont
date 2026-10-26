package api_test

// The kinds of id, held to specs/src/identifiers/kinds.json as every SDK's
// checked constructors are: each kind takes every id the table accepts and
// refuses every one it refuses, by its constructor and by decoding, and a wire
// type that carries the kind decodes through the same rule.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

type kindCase struct {
	ID  string `json:"id"`
	Why string `json:"why"`
}

type kindRow struct {
	Schema  string     `json:"schema"`
	Accepts []kindCase `json:"accepts"`
	Refuses []kindCase `json:"refuses"`
}

// kind is what a test asks of one kind of id: to make one from text, and to
// decode one from JSON.
type kind struct {
	parse  func(string) (fmt.Stringer, error)
	decode func([]byte) error
	zero   fmt.Stringer
}

// kinds is each kind of id by its schema's name. The table names the kinds;
// TestEveryKindOfTheTableIsAType holds this map to it, so a kind the table
// gains, or loses, fails here before anything else does.
var kinds = map[string]kind{
	"ResourceId": {
		parse:  func(s string) (fmt.Stringer, error) { return api.ParseResourceId(s) },
		decode: func(b []byte) error { var id api.ResourceId; return json.Unmarshal(b, &id) },
		zero:   api.ResourceId{},
	},
	"AnnotationId": {
		parse:  func(s string) (fmt.Stringer, error) { return api.ParseAnnotationId(s) },
		decode: func(b []byte) error { var id api.AnnotationId; return json.Unmarshal(b, &id) },
		zero:   api.AnnotationId{},
	},
	"JobId": {
		parse:  func(s string) (fmt.Stringer, error) { return api.ParseJobId(s) },
		decode: func(b []byte) error { var id api.JobId; return json.Unmarshal(b, &id) },
		zero:   api.JobId{},
	},
	"UserId": {
		parse:  func(s string) (fmt.Stringer, error) { return api.ParseUserId(s) },
		decode: func(b []byte) error { var id api.UserId; return json.Unmarshal(b, &id) },
		zero:   api.UserId{},
	},
}

func table(t *testing.T) []kindRow {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "specs", "src", "identifiers", "kinds.json"))
	if err != nil {
		t.Fatal(err)
	}
	var read struct {
		Kinds []kindRow `json:"kinds"`
	}
	if err := json.Unmarshal(b, &read); err != nil {
		t.Fatal(err)
	}
	if len(read.Kinds) == 0 {
		t.Fatal("the table names no kinds: every test below would pass for the wrong reason")
	}
	return read.Kinds
}

func TestEveryKindOfTheTableIsAType(t *testing.T) {
	var named, typed []string
	for _, row := range table(t) {
		named = append(named, row.Schema)
	}
	for name := range kinds {
		typed = append(typed, name)
	}
	sort.Strings(named)
	sort.Strings(typed)
	if fmt.Sprint(named) != fmt.Sprint(typed) {
		t.Fatalf("the table's kinds are %v; this test knows %v", named, typed)
	}
}

func TestAKindTakesWhatTheTableAccepts(t *testing.T) {
	for _, row := range table(t) {
		k := kinds[row.Schema]
		for _, c := range row.Accepts {
			id, err := k.parse(c.ID)
			if err != nil {
				t.Errorf("%s refuses %q (%s): %v", row.Schema, c.ID, c.Why, err)
				continue
			}
			if id.String() != c.ID {
				t.Errorf("%s made from %q reads %q", row.Schema, c.ID, id.String())
			}
			if err := k.decode([]byte(strconv.Quote(c.ID))); err != nil {
				t.Errorf("%s refuses to decode %q (%s): %v", row.Schema, c.ID, c.Why, err)
			}
			written, err := json.Marshal(id)
			if err != nil || string(written) != strconv.Quote(c.ID) {
				t.Errorf("%s %q is written as %s (%v)", row.Schema, c.ID, written, err)
			}
		}
	}
}

func TestAKindRefusesWhatTheTableRefuses(t *testing.T) {
	for _, row := range table(t) {
		k := kinds[row.Schema]
		for _, c := range row.Refuses {
			_, err := k.parse(c.ID)
			var invalid *api.InvalidIdentifierError
			if !errors.As(err, &invalid) {
				t.Errorf("%s takes %q, which the table refuses (%s): %v", row.Schema, c.ID, c.Why, err)
				continue
			}
			if invalid.Kind != row.Schema || invalid.Value != c.ID {
				t.Errorf("%s's refusal of %q names %s and %q", row.Schema, c.ID, invalid.Kind, invalid.Value)
			}
			if err := k.decode([]byte(strconv.Quote(c.ID))); err == nil {
				t.Errorf("%s decodes %q, which the table refuses (%s)", row.Schema, c.ID, c.Why)
			}
		}
	}
}

func TestTheZeroValueIsNoId(t *testing.T) {
	for name, k := range kinds {
		if _, err := json.Marshal(k.zero); err == nil {
			t.Errorf("a zero %s is written, though it names nothing", name)
		}
	}
}

func TestAWireTypeDecodesItsIdsThroughTheRule(t *testing.T) {
	var accepted api.BrowseResourceRequest
	if err := json.Unmarshal([]byte(`{"resourceId":"res-1"}`), &accepted); err != nil {
		t.Fatalf("a request naming res-1 is refused: %v", err)
	}
	if accepted.ResourceId.String() != "res-1" {
		t.Errorf("the request names %q", accepted.ResourceId.String())
	}
	var refused api.BrowseResourceRequest
	if err := json.Unmarshal([]byte(`{"resourceId":"a/b"}`), &refused); err == nil {
		t.Error("a request naming a/b is read, though a/b is no resource's id")
	}
}
