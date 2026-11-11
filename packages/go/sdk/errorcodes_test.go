package semiont_test

// The failure vocabularies' two mappings, held to protocol/specs/src/errors/codes.json:
// the code an HTTP status becomes, and the bus code a peer's wire code becomes.
// That each vocabulary's constants are the table's codes is the drift gate's:
// the file is generated from the table and checked against it.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

type codeEntry struct {
	Code       string `json:"code"`
	Wire       string `json:"wire"`
	Status     *int   `json:"status"`
	StatusFrom *int   `json:"statusFrom"`
}

type codesTable struct {
	BusRequest struct {
		UnrecognizedFailure string      `json:"unrecognizedFailure"`
		Codes               []codeEntry `json:"codes"`
	} `json:"busRequest"`
	Transport struct {
		Unclassified string      `json:"unclassified"`
		Codes        []codeEntry `json:"codes"`
	} `json:"transport"`
}

func readCodes(t *testing.T) codesTable {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "specs", "src", "errors", "codes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table codesTable
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.BusRequest.Codes) == 0 || len(table.Transport.Codes) == 0 {
		t.Fatal("the table states no bus or transport codes: every test below would pass for the wrong reason")
	}
	return table
}

func TestAStatusBecomesTheTransportCodeTheTableGivesIt(t *testing.T) {
	table := readCodes(t)
	stated := map[int]bool{}
	for _, entry := range table.Transport.Codes {
		want := semiont.TransportErrorCode(entry.Code)
		switch {
		case entry.Status != nil:
			stated[*entry.Status] = true
			if got := semiont.TransportErrorCodeOfStatus(*entry.Status); got != want {
				t.Errorf("status %d becomes %q; the table says %q", *entry.Status, got, want)
			}
		case entry.StatusFrom != nil:
			for _, status := range []int{*entry.StatusFrom, *entry.StatusFrom + 3, *entry.StatusFrom + 99} {
				stated[status] = true
				if got := semiont.TransportErrorCodeOfStatus(status); got != want {
					t.Errorf("status %d, at or above %d, becomes %q; the table says %q", status, *entry.StatusFrom, got, want)
				}
			}
		}
	}
	unclassified := semiont.TransportErrorCode(table.Transport.Unclassified)
	for _, status := range []int{302, 418, 422} {
		if stated[status] {
			continue
		}
		if got := semiont.TransportErrorCodeOfStatus(status); got != unclassified {
			t.Errorf("status %d, which the table maps to nothing, becomes %q; the table says %q", status, got, unclassified)
		}
	}
}

func TestAWireCodeBecomesTheBusCodeThatRestatesIt(t *testing.T) {
	table := readCodes(t)
	unrecognized := semiont.BusRequestErrorCode(table.BusRequest.UnrecognizedFailure)
	for _, entry := range table.BusRequest.Codes {
		code := semiont.BusRequestErrorCode(entry.Code)
		wire, restates := code.Wire()
		if entry.Wire == "" {
			if restates {
				t.Errorf("%q restates the wire code %q; the table says it restates none", code, wire)
			}
			continue
		}
		if !restates || string(wire) != entry.Wire {
			t.Errorf("%q restates %q (%v); the table says %q", code, wire, restates, entry.Wire)
		}
		stated := api.CommandErrorCode(entry.Wire)
		if got := semiont.BusRequestErrorCodeOfWire(&stated); got != code {
			t.Errorf("the wire code %q becomes %q; the table says %q", entry.Wire, got, code)
		}
	}
	if got := semiont.BusRequestErrorCodeOfWire(nil); got != unrecognized {
		t.Errorf("a failure that states no code becomes %q; the table says %q", got, unrecognized)
	}
}

// A failure is read with no code CommandErrorCode does not name: its reader
// leaves one the required table does not recognize out
// (replies_test.go's rejection in its own words). Given one, the mapping says
// the table and CommandError disagree, and becomes no code.
func TestACodeCommandErrorCodeDoesNotNameBecomesNoBusCode(t *testing.T) {
	unknown := api.CommandErrorCode("a-code-no-table-names")
	// What the mapping gives, or what it panics with.
	said := func() (said any) {
		defer func() {
			if refused := recover(); refused != nil {
				said = refused
			}
		}()
		return semiont.BusRequestErrorCodeOfWire(&unknown)
	}()
	if message, ok := said.(string); !ok || !strings.Contains(message, `"a-code-no-table-names" is none of CommandErrorCode's`) {
		t.Errorf("a code CommandErrorCode does not name is mapped to %v", said)
	}
}
