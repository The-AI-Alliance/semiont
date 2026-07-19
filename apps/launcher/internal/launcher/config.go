package launcher

// config.go — the launcher's read-side of the semiontconfig TOML schema
// (owned by packages/core; documented in docs/system/administration/
// CONFIGURATION.md). Only the keys the launcher consumes are modeled;
// everything else is deliberately ignored — the launcher is a consumer of
// the schema, never a fork of it. See .plans/LAUNCHER-CONFIG-SYNC.md.

import (
	"fmt"
	"os"

	toml "github.com/pelletier/go-toml/v2"
)

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

// loadConfig parses a semiontconfig TOML and selects the defaults.environment
// block. ${VAR} references stay verbatim in the values — classification of
// addresses happens at derivation, interpolation stays the containers' job.
func loadConfig(path string) (*envConfig, string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, "", fmt.Errorf("reading %s: %v", path, err)
	}
	var cfg semiontConfig
	if err := toml.Unmarshal(b, &cfg); err != nil {
		return nil, "", fmt.Errorf("%s is not valid TOML: %v", path, err)
	}
	envName := cfg.Defaults.Environment
	if envName == "" {
		return nil, "", fmt.Errorf("%s: [defaults] environment is not set", path)
	}
	env, ok := cfg.Environments[envName]
	if !ok {
		return nil, "", fmt.Errorf("%s: environment %q selected by [defaults] is not defined", path, envName)
	}
	return &env, envName, nil
}
