package semiont

// What a bus log shows of a payload, held to specs/src/bus/log-cases.json: the
// table every bus log runs. A runner compares values, never text.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"go.opentelemetry.io/otel/trace"
)

type busLogTable struct {
	Names []string `json:"names"`
	Cases []struct {
		Why     string `json:"why"`
		Payload any    `json:"payload"`
		Shown   any    `json:"shown"`
	} `json:"cases"`
}

func readBusLogTable(t *testing.T) busLogTable {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "specs", "src", "bus", "log-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table busLogTable
	if err := json.Unmarshal(text, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Names) == 0 || len(table.Cases) == 0 {
		t.Fatal("the table was not read")
	}
	return table
}

func TestTheNamesThisLogWithholdsUnderAreTheTablesAndNoOthers(t *testing.T) {
	table := readBusLogTable(t)
	var held []string
	for name := range credentials {
		held = append(held, name)
	}
	slices.Sort(held)
	stated := slices.Sorted(slices.Values(table.Names))
	if !slices.Equal(held, stated) {
		t.Errorf("this log withholds under %v, and the table names %v", held, stated)
	}
}

func TestTheValueOfAMemberUnderEachNameOfTheTableIsWithheld(t *testing.T) {
	for _, name := range readBusLogTable(t).Names {
		got := withheldFrom(map[string]any{name: "a-credential", "beside": "shown"})
		if want := map[string]any{name: withheld, "beside": "shown"}; !reflect.DeepEqual(got, want) {
			t.Errorf("%s: shown as %v", name, got)
		}
	}
}

func TestEveryPayloadOfTheTableIsShownAsTheTableSays(t *testing.T) {
	table := readBusLogTable(t)
	carrying := 0
	for _, stated := range table.Cases {
		if got := withheldFrom(stated.Payload); !reflect.DeepEqual(got, stated.Shown) {
			t.Errorf("%s: shown as %v", stated.Why, got)
		}
		if !reflect.DeepEqual(stated.Payload, stated.Shown) {
			carrying++
		}
	}
	if carrying == 0 || carrying == len(table.Cases) {
		t.Errorf("the table has no case that carries a credential, or none that carries none (%d of %d do)", carrying, len(table.Cases))
	}
}

func TestAnArrayIsReadByTheSameRuleAndAnythingElseIsShownAsItIs(t *testing.T) {
	got := withheldFrom([]any{map[string]any{"token": "a-credential"}, "token", nil})
	if want := []any{map[string]any{"token": withheld}, "token", nil}; !reflect.DeepEqual(got, want) {
		t.Errorf("an array is shown as %v", got)
	}
	for _, value := range []any{"token", 3.5, true, nil} {
		if got := withheldFrom(value); got != value {
			t.Errorf("%v is shown as %v", value, got)
		}
	}
}

func TestALineSaysItsChannelScopeCorrelationAndTraceAndThenThePayload(t *testing.T) {
	scope, err := api.ParseResourceId("res-1")
	if err != nil {
		t.Fatal(err)
	}
	traceID, err := trace.TraceIDFromHex("8f3ca4ed000000000000000000000001")
	if err != nil {
		t.Fatal(err)
	}
	within := trace.ContextWithSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: trace.SpanID{1}}))
	payload := map[string]any{"resourceId": "res-1", "token": "a-credential", "note": "<a> & <b>"}
	line := busLine(within, busEmit, "mark:create-request", payload, Envelope{CorrelationID: "a89a670a-1111-2222", Scope: scope})
	tag := "[bus EMIT] mark:create-request scope=res-1 cid=a89a670a trace=8f3ca4ed "
	if !strings.HasPrefix(line, tag) {
		t.Fatalf("the line is %q", line)
	}
	var written any
	if err := json.Unmarshal([]byte(line[len(tag):]), &written); err != nil {
		t.Fatalf("the line's payload is not JSON: %q", line)
	}
	if want := map[string]any{"resourceId": "res-1", "token": withheld, "note": "<a> & <b>"}; !reflect.DeepEqual(written, want) {
		t.Errorf("the line shows %v", written)
	}
	if strings.Contains(line, `\u003c`) {
		t.Errorf("the line escapes what JSON need not: %q", line)
	}
	// With no scope, no correlation and no trace, the line says none of them.
	bare := busLine(context.Background(), busGet, "content", map[string]any{"resourceId": "res-1"}, Envelope{})
	if bare != `[bus GET] content {"resourceId":"res-1"}` {
		t.Errorf("the line is %q", bare)
	}
}
