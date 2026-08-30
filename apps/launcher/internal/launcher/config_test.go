package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The gateway/backend section alias, pinned row for row.
//
// packages/core/src/__tests__/config/toml-loader.test.ts pins these SAME four
// rows against the TypeScript loader. The two lanes parse the file
// independently and share no schema, so this pair of blocks is the only thing
// keeping them from drifting. Change one, change the other.
//
// Note the lanes are NOT symmetric in what they read: Go takes platform+port,
// TypeScript also takes publicURL (confgen writes it and the launcher never
// reads it back). The four PRESENCE rows below are what must match — not the
// field sets.
func writeConfigTOML(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "semiontconfig.toml")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

const aliasHead = "[defaults]\nenvironment = \"local\"\n\n"

func TestGatewaySectionAlias(t *testing.T) {
	t.Run("row 1 — gateway only: used", func(t *testing.T) {
		p := writeConfigTOML(t, aliasHead+"[environments.local.gateway]\nplatform = \"posix\"\nport = 3001\n")
		env, _, _, err := loadConfig(p)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if env.Gateway == nil {
			t.Fatal("gateway section did not resolve")
		}
		if env.Gateway.Port != 3001 {
			t.Errorf("port = %d, want 3001", env.Gateway.Port)
		}
	})

	t.Run("row 2 — backend only: used, and lands on Gateway (the compat path)", func(t *testing.T) {
		// The point of the alias: a fleet KB still spelling it `backend` loads,
		// and every reader downstream sees the ONE current field.
		p := writeConfigTOML(t, aliasHead+"[environments.local.backend]\nplatform = \"posix\"\nport = 3001\n")
		env, _, _, err := loadConfig(p)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if env.Gateway == nil {
			t.Fatal("backend section did not resolve onto Gateway")
		}
		if env.Gateway.Port != 3001 {
			t.Errorf("port = %d, want 3001", env.Gateway.Port)
		}
		if env.GatewayOld != nil {
			t.Error("GatewayOld survived resolution; readers could see two sources")
		}
	})

	t.Run("row 3 — both: rejected, naming both keys", func(t *testing.T) {
		// Not "gateway wins". Both present means half-migrated — a mistake just
		// made — and choosing silently hides which section is live.
		p := writeConfigTOML(t, aliasHead+
			"[environments.local.gateway]\nplatform = \"posix\"\nport = 3001\n\n"+
			"[environments.local.backend]\nplatform = \"posix\"\nport = 4001\n")
		_, _, _, err := loadConfig(p)
		if err == nil {
			t.Fatal("want an error when both spellings are present, got nil")
		}
		for _, want := range []string{"gateway", "backend", "local"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("error does not name %q: %v", want, err)
			}
		}
	})

	t.Run("row 4 — neither: absent, and nothing is invented", func(t *testing.T) {
		p := writeConfigTOML(t, aliasHead+"[environments.local.graph]\ntype = \"memory\"\n")
		env, _, _, err := loadConfig(p)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if env.Gateway != nil {
			t.Errorf("Gateway was manufactured from an absent section: %+v", env.Gateway)
		}
	})
}

// confgen must mint NEW knowledge bases on the current spelling. If it kept
// writing `backend`, the alias above could never expire — every `semiont init`
// would create another repo needing migration.
func TestConfgenEmitsCurrentSpelling(t *testing.T) {
	out := generateSemiontconfig(genParams{Inference: "anthropic", Model: "m", EmbeddingModel: "nomic-embed-text"})
	if !strings.Contains(out, "[environments.local.gateway]") {
		t.Error("generated config does not use the [gateway] section")
	}
	if strings.Contains(out, "[environments.local.backend]") {
		t.Error("generated config still mints the deprecated [backend] section")
	}
}
