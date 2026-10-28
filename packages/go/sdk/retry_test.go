package semiont_test

// Trying again, held to the cases every SDK runs (specs/src/retry/cases.json).
// The table states four rules. This SDK keeps the ones it has a use for, and
// the rest are named below with why: a rule the table gains, or one this SDK
// comes to keep, fails here until this file says so.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// notKept is each rule of the table this SDK does not keep, with why.
var notKept = map[string]string{
	"job": "a job's retry budget is its worker's, and the Go SDK runs no worker service of its own",
}

type retryRow struct {
	Why     string  `json:"why"`
	Rule    string  `json:"rule"`
	Status  *int    `json:"status"`
	Method  *string `json:"method"`
	Retries bool    `json:"retries"`
}

type statedWait struct {
	Why    string  `json:"why"`
	Header *string `json:"header"`
	Ms     *int64  `json:"ms"`
}

func readRetryTable(t *testing.T) (rules []retryRow, waits []statedWait) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "specs", "src", "retry", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Rules      []retryRow   `json:"rules"`
		RetryAfter []statedWait `json:"retryAfter"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Rules) == 0 || len(table.RetryAfter) == 0 {
		t.Fatal("the table states no rules or no waits: every test below would pass for the wrong reason")
	}
	return table.Rules, table.RetryAfter
}

func keptRules() map[string]semiont.RetryRule {
	kept := map[string]semiont.RetryRule{}
	for _, rule := range semiont.RetryRules() {
		kept[rule.Name] = rule
	}
	return kept
}

func TestEveryRuleOfTheTableIsKeptOrNamedAsNotKept(t *testing.T) {
	rows, _ := readRetryTable(t)
	stated := map[string]bool{}
	for _, row := range rows {
		stated[row.Rule] = true
	}
	kept := keptRules()
	var named, missing []string
	for name := range stated {
		named = append(named, name)
		_, isKept := kept[name]
		_, isNot := notKept[name]
		if isKept == isNot {
			missing = append(missing, name)
		}
	}
	for name := range kept {
		if !stated[name] {
			missing = append(missing, name)
		}
	}
	for name, why := range notKept {
		if !stated[name] || why == "" {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("the table's rules are %v; each must be kept or named, once, with why: %v", named, missing)
	}
}

func TestARuleAnswersAsTheTableDoes(t *testing.T) {
	rows, _ := readRetryTable(t)
	kept := keptRules()
	for _, row := range rows {
		rule, isKept := kept[row.Rule]
		if !isKept {
			continue
		}
		facts := semiont.RetryFacts{Status: row.Status, Method: row.Method}
		if got := rule.Retryable(facts); got != row.Retries {
			t.Errorf("%s: %s retries %v; the table says %v", row.Rule, row.Why, got, row.Retries)
		}
	}
}

func TestARetryAfterHeaderStatesTheWaitTheTableGives(t *testing.T) {
	_, waits := readRetryTable(t)
	for _, row := range waits {
		header := ""
		if row.Header != nil {
			header = *row.Header
		}
		wait, ok := semiont.RetryAfter(header)
		switch {
		case row.Ms == nil && ok:
			t.Errorf("%s: %q states a wait of %v; the table says none", row.Why, header, wait)
		case row.Ms != nil && (!ok || wait != time.Duration(*row.Ms)*time.Millisecond):
			t.Errorf("%s: %q states %v (%v); the table says %d ms", row.Why, header, wait, ok, *row.Ms)
		}
	}
}

func TestJitterStaysBetweenHalfTheCapAndTheCap(t *testing.T) {
	for range 1000 {
		if wait := semiont.EqualJitter(time.Second); wait < 500*time.Millisecond || wait > time.Second {
			t.Fatalf("a jittered wait of %v, for a cap of 1s", wait)
		}
	}
}
