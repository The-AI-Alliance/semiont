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
// (optional). These are the ones the launcher injects itself, so it neither
// demands nor forwards them from the user's environment.
var injectedVars = map[string]bool{
	"GATEWAY_HOST": true, "BACKEND_HOST": true, "NEO4J_HOST": true, "QDRANT_HOST": true,
	"OLLAMA_HOST": true, "POSTGRES_HOST": true, "NATS_HOST": true, "KEYCLOAK_HOST": true, "KEYCLOAK_PORT": true,
	"SEMIONT_OIDC_CLIENT_ID": true, "SEMIONT_OIDC_CLIENT_SECRET": true,
}

// referenceRe: a value that is exactly one required reference, ${NAME}.
var referenceRe = regexp.MustCompile(`^\$\{([A-Z_][A-Z0-9_]*)\}$`)

// referenceName is NAME when value is exactly ${NAME}, and "" when it is
// anything else — a literal, a default, or a reference inside other text.
func referenceName(value string) string {
	if m := referenceRe.FindStringSubmatch(value); m != nil {
		return m[1]
	}
	return ""
}

// placeholderRefs: the variables a value names, by the resolver's own
// pattern — required (${NAME}), or optional (${NAME:-default}) when every
// reference to the name carries a default. In order of first appearance.
func placeholderRefs(value string) (required, optional []string) {
	isRequired := map[string]bool{}
	var names []string
	for _, m := range placeholderRe.FindAllStringSubmatch(value, -1) {
		name, _, hasDefault := strings.Cut(m[1], ":-")
		if _, seen := isRequired[name]; !seen {
			names = append(names, name)
		}
		isRequired[name] = isRequired[name] || !hasDefault
	}
	for _, name := range names {
		if isRequired[name] {
			required = append(required, name)
		} else {
			optional = append(optional, name)
		}
	}
	return required, optional
}

// configRefs: the variables a config names, minus those the launcher
// injects. Start demands the required ones and forwards an optional one only
// when it is set, so the container's loader lets a set variable win over its
// default.
type configRefs struct {
	Required, Optional []string
	// ByService: which of them each stack service is handed (serviceVars).
	ByService map[string][]string
}

// referencedVars walks every string value in the parsed document for ${VAR}
// references, minus the launcher-injected set. A name required anywhere is
// required. Deliberately the WHOLE
// document, not the typed model: the containers interpolate refs in keys the
// launcher doesn't consume (apiKey, custom sections), and refs may live in
// any environment. Walking parsed VALUES (not raw bytes) means a ${VAR} in a
// TOML comment no longer creates a phantom requirement.
func referencedVars(doc any) configRefs {
	isRequired := map[string]bool{}
	var walk func(v any)
	walk = func(v any) {
		switch t := v.(type) {
		case string:
			required, optional := placeholderRefs(t)
			for _, name := range required {
				if !injectedVars[name] {
					isRequired[name] = true
				}
			}
			for _, name := range optional {
				if _, named := isRequired[name]; !named && !injectedVars[name] {
					isRequired[name] = false
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
	var refs configRefs
	for name, required := range isRequired {
		if required {
			refs.Required = append(refs.Required, name)
		} else {
			refs.Optional = append(refs.Optional, name)
		}
	}
	sort.Strings(refs.Required)
	sort.Strings(refs.Optional)
	return refs
}

type semiontConfig struct {
	Defaults struct {
		Environment string `toml:"environment"`
	} `toml:"defaults"`
	Environments map[string]envConfig `toml:"environments"`
}

type envConfig struct {
	// Two spellings of one section. `gateway` is current; `backend` is the
	// pre-rename key the KB fleet still carries, accepted until every fleet
	// repo has moved. loadConfig collapses them into Gateway and rejects a
	// file that sets both — see resolveGatewaySection.
	Gateway    *gatewayCfg            `toml:"gateway"`
	GatewayOld *gatewayCfg            `toml:"backend"`
	Graph      *graphCfg              `toml:"graph"`
	Vectors    *vectorsCfg            `toml:"vectors"`
	Embedding  *embeddingCfg          `toml:"embedding"`
	Inference  map[string]providerCfg `toml:"inference"`
	Database   *databaseCfg           `toml:"database"`
	// Jobs selects the gateway's job-queue driver (JOB-QUEUE-DRIVER P2).
	// Absent = the in-gateway fs driver; nothing to launch.
	Jobs     *jobsCfg              `toml:"jobs"`
	Signal   *signalCfg            `toml:"signal"`
	Identity *identityCfg          `toml:"identity"`
	Actors   map[string]bindingCfg `toml:"actors"`
	Workers  map[string]bindingCfg `toml:"workers"`
	// Site is read ONLY to refuse it (loadConfig). A knowledge base declares
	// [site] once, at the top level of its committed .semiont/config; an
	// environment cannot override it, here or in any service's loader.
	Site map[string]any `toml:"site"`
	// Archivist: a hand-written address for the Archivist — a topology the
	// launcher cannot see. Absent, the launcher supplies its own.
	Archivist *archivistCfg `toml:"archivist"`
	// LogLevel is the environment's log level, written into the gateway's
	// configuration document (gatewaydoc.go).
	LogLevel string `toml:"logLevel"`
}

// declaresRole answers whether this config declares a role — the section
// that would make it part of the stack. It is the DECLARE half of O1
// (drivers require roles, configs declare them), read by unmetRequirement
// when a driver names a role it cannot run without.
//
// Only the roles a `needs` edge can name appear here, and
// TestEveryRequiredRoleIsDeclarable fails when a new requirement names one
// this cannot answer for — a silent "yes" would turn a refusal into a
// missing-section panic three steps later.
func (e *envConfig) declaresRole(role string) bool {
	switch role {
	case "database":
		return e.Database != nil
	case "graph":
		return e.Graph != nil
	case "vectors":
		return e.Vectors != nil
	case "embedding":
		return e.Embedding != nil
	case "identity":
		return e.Identity != nil
	case "messaging":
		return e.Jobs != nil || e.Signal != nil
	case "inference":
		return len(e.Inference) > 0
	case "gateway":
		return e.Gateway != nil || e.GatewayOld != nil
	}
	return false
}

type gatewayCfg struct {
	Platform string `toml:"platform"`
	Port     int    `toml:"port"`
	// PublicURL: where clients reach the gateway — the servers entry of the
	// OpenAPI document it serves. Written into its configuration document.
	PublicURL string `toml:"publicURL"`
}

type archivistCfg struct {
	Host string `toml:"host"`
	Port int    `toml:"port"`
}

type graphCfg struct {
	Platform string `toml:"platform"`
	Type     string `toml:"type"`
	URI      string `toml:"uri"`
	Username string `toml:"username"`
	Password string `toml:"password"`
	Image    string `toml:"image"` // optional: override the catalog's default image
}

type vectorsCfg struct {
	Platform string `toml:"platform"`
	Type     string `toml:"type"`
	Host     string `toml:"host"`
	Port     int    `toml:"port"`
	Image    string `toml:"image"` // optional: override the catalog's default image
}

type embeddingCfg struct {
	Platform string `toml:"platform"`
	Type     string `toml:"type"`
	Model    string `toml:"model"`
	BaseURL  string `toml:"baseURL"`
}

type providerCfg struct {
	Platform string `toml:"platform"`
	Endpoint string `toml:"endpoint"`
	BaseURL  string `toml:"baseURL"`
	APIKey   string `toml:"apiKey"`
	Image    string `toml:"image"` // optional (ollama): override the catalog's default image
}

type databaseCfg struct {
	Platform string `toml:"platform"`
	Type     string `toml:"type"`
	Host     string `toml:"host"`
	Port     int    `toml:"port"`
	Name     string `toml:"name"`
	User     string `toml:"user"`
	Password string `toml:"password"`
	Image    string `toml:"image"` // optional: override the catalog's default image
}

// jobsCfg mirrors the TypeScript JobsServiceConfig: type "fs" | "jetstream",
// and for jetstream a servers address whose host may be the launcher-injected
// ${NATS_HOST} (provided) or anything else (externally provided broker).
type jobsCfg struct {
	Type    string `toml:"type"`
	Servers string `toml:"servers"`
	// Broker credentials. Named by the CONFIG like every other service
	// credential here — graph carries neo4j's, database carries postgres's —
	// and delivered to the daemon as its own environment, never as argv.
	User     string `toml:"user"`
	Password string `toml:"password"`
}

// signalCfg mirrors jobsCfg for [environments.<env>.signal] (SIGNAL-PLANE
// P2): the gateway selects its Signal Plane driver from this section; the
// LAUNCHER reads it only to decide whether the messaging daemon must run.
type signalCfg struct {
	Type    string `toml:"type"`
	Servers string `toml:"servers"`
	// The same broker as [jobs], so the same pair; plan.go refuses a
	// disagreement rather than picking one.
	User     string `toml:"user"`
	Password string `toml:"password"`
}

// identityCfg mirrors the TypeScript IdentityServiceConfig: type "keycloak" |
// "oidc", the issuer URL the gateway trusts (a keycloak issuer on the
// launcher-injected ${KEYCLOAK_HOST} is provided; any other host, and every
// oidc issuer, is external). The audience is NOT configured: it is derived
// from the KB's committed did:web domain (kbResource).
type identityCfg struct {
	Type   string `toml:"type"`
	Issuer string `toml:"issuer"`
	// SubjectClaim: the issuer claim a person's DID is built from —
	// did:web:<site domain>:users:<its value>. Required; declared, never
	// defaulted. The gateway reads it; the launcher only vets its presence, so
	// no path writes a config the gateway's loader would refuse.
	SubjectClaim string `toml:"subjectClaim"`
	Image        string `toml:"image"` // optional: override the catalog's default image
	// AccessTokenLifespan: seconds a token the realm mints stays valid, and so
	// the window in which a disabled account can still act. Optional; absent
	// means keycloakAccessTokenLifespan. Pointer because 0 is a value someone
	// could type and a meaningless one — absent and zero must be told apart.
	//
	// Only the launcher reads it, because only the launcher writes a realm:
	// `type = "oidc"` names an issuer somebody else configures, and setting
	// this there is refused rather than ignored.
	AccessTokenLifespan *int `toml:"accessTokenLifespan"`
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
func loadConfig(path string) (*envConfig, string, configRefs, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, "", configRefs{}, fmt.Errorf("reading %s: %v", path, err)
	}
	var cfg semiontConfig
	if err := toml.Unmarshal(b, &cfg); err != nil {
		return nil, "", configRefs{}, fmt.Errorf("%s is not valid TOML: %v", path, err)
	}
	var doc any
	if err := toml.Unmarshal(b, &doc); err != nil {
		return nil, "", configRefs{}, fmt.Errorf("%s is not valid TOML: %v", path, err)
	}
	if err := refuseEnvironmentSites(cfg.Environments, path); err != nil {
		return nil, "", configRefs{}, err
	}
	envName := cfg.Defaults.Environment
	if envName == "" {
		return nil, "", configRefs{}, fmt.Errorf("%s: [defaults] environment is not set", path)
	}
	env, ok := cfg.Environments[envName]
	if !ok {
		return nil, "", configRefs{}, fmt.Errorf("%s: environment %q selected by [defaults] is not defined", path, envName)
	}
	if err := resolveGatewaySection(&env, path, envName); err != nil {
		return nil, "", configRefs{}, err
	}
	refs := referencedVars(doc)
	refs.ByService = serviceVars(doc, envName, &env)
	return &env, envName, refs, nil
}

// refuseEnvironmentSites rejects a [site] section in any environment, selected
// or not — the whole file is staged into every service, and their loader
// (toml-loader.ts) refuses the same section by name. A knowledge base declares
// [site] once, at the top level of its committed .semiont/config.
func refuseEnvironmentSites(envs map[string]envConfig, path string) error {
	var sited []string
	for name, env := range envs {
		if env.Site != nil {
			sited = append(sited, fmt.Sprintf("[environments.%s.site]", name))
		}
	}
	if len(sited) == 0 {
		return nil
	}
	sort.Strings(sited)
	return fmt.Errorf(
		"%s in %s: a knowledge base declares [site] once, at the top level of its committed .semiont/config, "+
			"and no environment can override it. Delete the section.",
		strings.Join(sited, ", "), path)
}

// resolveGatewaySection collapses the `gateway` / `backend` spellings of one
// section into env.Gateway.
//
// A file that sets BOTH is half-migrated — a mistake someone just made, not a
// state worth supporting — so it is rejected by name rather than resolved by
// precedence. Silently preferring one would leave the next reader unable to
// tell which section is live.
//
// The TypeScript loader implements the same four cases independently; neither
// lane can see the other's schema, so both are pinned by parity tests.
func resolveGatewaySection(env *envConfig, path, envName string) error {
	if env.Gateway != nil && env.GatewayOld != nil {
		return fmt.Errorf(
			"%s: environment %q declares both [environments.%s.gateway] and [environments.%s.backend]; "+
				"they are one section under two spellings — keep gateway and delete backend",
			path, envName, envName, envName)
	}
	if env.Gateway == nil {
		env.Gateway = env.GatewayOld
	}
	env.GatewayOld = nil
	return nil
}
