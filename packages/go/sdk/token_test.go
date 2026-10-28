package semiont

// How a token is held, by the session table every SDK runs
// (specs/src/session/cases.json): reading a token's expiry, and how long to
// wait before renewing it.

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type sessionTables struct {
	RefreshSchedule []struct {
		Why    string         `json:"why"`
		Claims map[string]any `json:"claims"`
		Token  *string        `json:"token"`
		Now    int64          `json:"now"`
		Delay  *int64         `json:"delay"`
	} `json:"refreshSchedule"`
	TokenExpiry []struct {
		Why   string `json:"why"`
		Token string `json:"token"`
		Exp   *int64 `json:"exp"`
	} `json:"tokenExpiry"`
}

func readSessionTables(t *testing.T) sessionTables {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "specs", "src", "session", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var tables sessionTables
	if err := json.Unmarshal(b, &tables); err != nil {
		t.Fatal(err)
	}
	if len(tables.RefreshSchedule) == 0 || len(tables.TokenExpiry) == 0 {
		t.Fatal("the table states no schedule or no expiry rows: every test below would pass for the wrong reason")
	}
	return tables
}

// aToken is a JWT carrying claims, its header and signature placeholders.
func aToken(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(payload) + ".c2lnbmF0dXJl"
}

func TestTheRenewalScheduleIsTheTables(t *testing.T) {
	for _, row := range readSessionTables(t).RefreshSchedule {
		token := ""
		if row.Token != nil {
			token = *row.Token
		} else {
			token = aToken(t, row.Claims)
		}
		delay, scheduled := RefreshDelay(token, time.Unix(row.Now, 0), DefaultTiming())
		switch {
		case row.Delay == nil && scheduled:
			t.Errorf("%s: scheduled a renewal in %s, want none", row.Why, delay)
		case row.Delay != nil && !scheduled:
			t.Errorf("%s: scheduled none, want a renewal in %ds", row.Why, *row.Delay)
		case row.Delay != nil && delay != time.Duration(*row.Delay)*time.Second:
			t.Errorf("%s: a renewal in %s, want %ds", row.Why, delay, *row.Delay)
		}
	}
}

func TestATokensExpiryIsReadAsTheTableReadsIt(t *testing.T) {
	for _, row := range readSessionTables(t).TokenExpiry {
		expiry, ok := TokenExpiry(row.Token)
		switch {
		case row.Exp == nil && ok:
			t.Errorf("%s: read an expiry of %s, want none", row.Why, expiry)
		case row.Exp != nil && !ok:
			t.Errorf("%s: read none, want %d", row.Why, *row.Exp)
		case row.Exp != nil && !expiry.Equal(time.Unix(*row.Exp, 0)):
			t.Errorf("%s: read %d, want %d", row.Why, expiry.Unix(), *row.Exp)
		}
	}
}

func TestATextClaimIsReadAndANumberIsNotText(t *testing.T) {
	token := aToken(t, map[string]any{"email": "zoë@example.org", "iat": 1800000000})
	if email, ok := TextClaim(token, "email"); !ok || email != "zoë@example.org" {
		t.Errorf("email read as %q (%v)", email, ok)
	}
	if iat, ok := TextClaim(token, "iat"); ok {
		t.Errorf("a number read as text: %q", iat)
	}
	if _, ok := TextClaim("not-a-jwt", "email"); ok {
		t.Error("a claim read from what is not a JWT")
	}
}
