package launcher

// tokens.go — per-stack session tokens from `semiont login`, in the
// launcher's state home. TOKENS, never passwords: the password crosses
// stdin once and dies with the process. 0600 throughout — these are
// bearer credentials. Keyed like stack.json ("local", "codespace:<repo>").

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

type tokenEntry struct {
	Token string `json:"token"` // short-lived access token (Bearer)
	// RefreshToken: long-lived (30d); stored so a later refresh flow can
	// renew without another password prompt.
	RefreshToken string    `json:"refreshToken,omitempty"`
	Email        string    `json:"email"`
	ObtainedAt   time.Time `json:"obtainedAt"`
}

func tokensPath() string {
	dir := stateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "tokens.json")
}

func loadTokens() map[string]tokenEntry {
	m := map[string]tokenEntry{}
	p := tokensPath()
	if p == "" {
		return m
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return m
	}
	_ = json.Unmarshal(b, &m)
	return m
}

// saveToken upserts one stack's session. Not best-effort: a login whose
// token cannot be stored has not logged you in — say so.
func saveToken(key string, e tokenEntry) error {
	p := tokensPath()
	if p == "" {
		return os.ErrNotExist
	}
	m := loadTokens()
	m[key] = e
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		// Never leave a bearer token sitting in a stray temp file.
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
