package semiont_test

// A knowledge base's gateway, made from its HTTP endpoint as every SDK makes
// it (specs/src/session/gateway-url-cases.json).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

func TestTheGatewaysOriginIsTheTables(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "specs", "src", "session", "gateway-url-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Why      string           `json:"why"`
			Endpoint api.HttpEndpoint `json:"endpoint"`
			Origin   *string          `json:"origin"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) == 0 {
		t.Fatal("the table states no cases")
	}
	for _, row := range table.Cases {
		origin, err := semiont.GatewayURL(row.Endpoint)
		switch {
		case row.Origin == nil && err == nil:
			t.Errorf("%s: made %q of a host that is no name", row.Why, origin)
		case row.Origin != nil && err != nil:
			t.Errorf("%s: refused (%v), want %q", row.Why, err, *row.Origin)
		case row.Origin != nil && origin != *row.Origin:
			t.Errorf("%s: made %q, want %q", row.Why, origin, *row.Origin)
		}
	}
}
