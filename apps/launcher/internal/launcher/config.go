package launcher

// config.go — the launcher's read-side of the semiontconfig TOML schema
// (owned by packages/core; documented in docs/system/administration/
// CONFIGURATION.md). Only the keys the launcher consumes are modeled;
// everything else is deliberately ignored — the launcher is a consumer of
// the schema, never a fork of it. See .plans/LAUNCHER-CONFIG-SYNC.md.

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
)

// The config TOMLs reference env vars as ${VAR} (required) or ${VAR:-default}
// (optional); only the required form is matched here. These are the ones the
// launcher injects itself and never demands from the user.
var injectedVars = map[string]bool{
	"BACKEND_HOST": true, "NEO4J_HOST": true, "QDRANT_HOST": true,
	"OLLAMA_HOST": true, "POSTGRES_HOST": true, "SEMIONT_WORKER_SECRET": true,
	"ADMIN_EMAIL": true, "ADMIN_PASSWORD": true,
}

var envRefRe = regexp.MustCompile(`\$\{[A-Z_][A-Z0-9_]*\}`)

// requiredVars walks every string value in the parsed document for required
// ${VAR} references, minus the launcher-injected set. Deliberately the WHOLE
// document, not the typed model: the containers interpolate refs in keys the
// launcher doesn't consume (apiKey, custom sections), and refs may live in
// any environment. Walking parsed VALUES (not raw bytes) means a ${VAR} in a
// TOML comment no longer creates a phantom requirement.
func requiredVars(doc any) []string {
	set := map[string]bool{}
	var walk func(v any)
	walk = func(v any) {
		switch t := v.(type) {
		case string:
			for _, m := range envRefRe.FindAllString(t, -1) {
				name := strings.TrimSuffix(strings.TrimPrefix(m, "${"), "}")
				if !injectedVars[name] {
					set[name] = true
				}
			}
		case map[string]any:
			for _, vv := range t {
				walk(vv)
			}
		case []any:
			for _, vv := range t {
				walk(vv)
			}
		}
	}
	walk(doc)
	names := make([]string, 0, len(set))
	for n := range set {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

type semiontConfig struct {
	Defaults struct {
		Environment string `toml:"environment"`
	} `toml:"defaults"`
	Environments map[string]envConfig `toml:"environments"`
}

type envConfig struct {
	Backend   *backendCfg            `toml:"backend"`
	Graph     *graphCfg              `toml:"graph"`
	Vectors   *vectorsCfg            `toml:"vectors"`
	Embedding *embeddingCfg          `toml:"embedding"`
	Inference map[string]providerCfg `toml:"inference"`
	Database  *databaseCfg           `toml:"database"`
	Actors    map[string]bindingCfg  `toml:"actors"`
	Workers   map[string]bindingCfg  `toml:"workers"`
}

type backendCfg struct {
	Platform string `toml:"platform"`
	Port     int    `toml:"port"`
}

type graphCfg struct {
	Platform string `toml:"platform"`
	Type     string `toml:"type"`
	URI      string `toml:"uri"`
	Username string `toml:"username"`
	Password string `toml:"password"`
}

type vectorsCfg struct {
	Platform string `toml:"platform"`
	Type     string `toml:"type"`
	Host     string `toml:"host"`
	Port     int    `toml:"port"`
}

type embeddingCfg struct {
	Platform string `toml:"platform"`
	Type     string `toml:"type"`
	BaseURL  string `toml:"baseURL"`
}

type providerCfg struct {
	Platform string `toml:"platform"`
	Endpoint string `toml:"endpoint"`
	BaseURL  string `toml:"baseURL"`
	APIKey   string `toml:"apiKey"`
}

type databaseCfg struct {
	Platform string `toml:"platform"`
	Type     string `toml:"type"`
	Host     string `toml:"host"`
	Port     int    `toml:"port"`
	Name     string `toml:"name"`
	User     string `toml:"user"`
	Password string `toml:"password"`
}

type bindingCfg struct {
	Inference struct {
		Type  string `toml:"type"`
		Model string `toml:"model"`
	} `toml:"inference"`
}

// loadConfig parses a semiontconfig TOML once, selecting the
// defaults.environment block and extracting the required ${VAR} references
// (the launcher's single reader of the file). ${VAR} values stay verbatim —
// classification happens at derivation, interpolation stays the containers'
// job.
func loadConfig(path string) (*envConfig, string, []string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, "", nil, fmt.Errorf("reading %s: %v", path, err)
	}
	var cfg semiontConfig
	if err := toml.Unmarshal(b, &cfg); err != nil {
		return nil, "", nil, fmt.Errorf("%s is not valid TOML: %v", path, err)
	}
	var doc any
	if err := toml.Unmarshal(b, &doc); err != nil {
		return nil, "", nil, fmt.Errorf("%s is not valid TOML: %v", path, err)
	}
	envName := cfg.Defaults.Environment
	if envName == "" {
		return nil, "", nil, fmt.Errorf("%s: [defaults] environment is not set", path)
	}
	env, ok := cfg.Environments[envName]
	if !ok {
		return nil, "", nil, fmt.Errorf("%s: environment %q selected by [defaults] is not defined", path, envName)
	}
	return &env, envName, requiredVars(doc), nil
}
