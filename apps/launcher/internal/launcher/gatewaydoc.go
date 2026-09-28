package launcher

// gatewaydoc.go — the gateway's configuration document: GatewayConfig in
// specs/, the Go type generated from it (packages/sdk-go). The user's ruling
// on GATEWAY-SIMPLIFY S1, 2026-09-27: "Resolved JSON doc". The launcher
// writes it for the gateway it starts, resolved — every ${VAR} a value, the
// way the gateway's own loader resolved it in the container before it read a
// document instead — so the gateway neither parses TOML nor resolves or
// defaults anything. Secrets are never values in it: a credential is a
// ${NAME} in the KB config, and the document names NAME.

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// placeholderRe: ${VAR} and ${VAR:-default}. The rule — a set variable wins
// even when empty, else the default, else a refusal — is shared with the
// TypeScript loader through specs/src/config-placeholders/cases.json.
var placeholderRe = regexp.MustCompile(`\$\{([^}]+)\}`)

func resolveRefs(field, value string, vars map[string]string) (string, error) {
	var missing error
	out := placeholderRe.ReplaceAllStringFunc(value, func(ref string) string {
		expr := ref[2 : len(ref)-1]
		name, def, hasDefault := strings.Cut(expr, ":-")
		if v, ok := vars[name]; ok {
			return v
		}
		if hasDefault {
			return def
		}
		if missing == nil {
			missing = fmt.Errorf("%s references ${%s}, which is not set", field, name)
		}
		return ref
	})
	return out, missing
}

// secretName: a credential's value in the KB config must be exactly ${NAME};
// the document names NAME and the value never leaves the environment.
var secretRefRe = regexp.MustCompile(`^\$\{([A-Z_][A-Z0-9_]*)\}$`)

func secretName(field, value string) (*string, error) {
	if value == "" {
		return nil, nil
	}
	m := secretRefRe.FindStringSubmatch(value)
	if m == nil {
		return nil, fmt.Errorf("%s must be a ${VAR} reference: the gateway's configuration document carries no secret value — set it in the environment and write %s = \"${NAME}\"", field, field)
	}
	return &m[1], nil
}

// gatewayVars: what a ${VAR} in the gateway's settings resolves against — the
// dependency hosts the launcher gives every service, and the user's own
// variables. The gateway-host variables are absent on purpose: the gateway
// never received them (gatewayArgs), so a ${GATEWAY_HOST:-…} in its
// publicURL takes its default, as it always has.
func gatewayVars(addr string, userEnv []string) map[string]string {
	vars := map[string]string{}
	for _, name := range []string{"POSTGRES_HOST", "NEO4J_HOST", "NATS_HOST", "KEYCLOAK_HOST", "QDRANT_HOST", "OLLAMA_HOST"} {
		vars[name] = addr
	}
	for i := 0; i+1 < len(userEnv); i += 2 {
		if userEnv[i] == "--env" {
			if name, value, ok := strings.Cut(userEnv[i+1], "="); ok {
				vars[name] = value
			}
		}
	}
	return vars
}

// connectionAllowance: the memory a gateway's capacity sets aside for each open
// connection — about twice what an idle stream measured (apps/gateway/bench).
const connectionAllowance = 20 << 10

// gatewayDocument renders the document from the selected environment, the
// KB's committed identity, the address the launcher computed, the port it
// publishes, and the user's variables. The absent-section decisions live here
// and nowhere else: no [signal] is the in-process plane, no logLevel is info,
// the log format is JSON (a KB config names none), no publicURL is the local
// address, and a hand-written archivist section wins over the launcher's.
func gatewayDocument(env *envConfig, kbName, kbDomain, addr string, port int, userEnv []string) ([]byte, error) {
	if kbDomain == "" {
		return nil, fmt.Errorf("the knowledge base declares no [site] domain in its .semiont/config: the gateway has no identity to run under")
	}
	if env.Identity == nil {
		return nil, fmt.Errorf("the environment declares no [identity]: the gateway has no issuer to trust")
	}
	vars := gatewayVars(addr, userEnv)
	var doc semiont.GatewayConfig
	var err error
	doc.Kb.Name, doc.Kb.Domain = kbName, kbDomain
	doc.Port = port

	publicURL := fmt.Sprintf("http://localhost:%d", port)
	if env.Gateway != nil && env.Gateway.PublicURL != "" {
		publicURL = env.Gateway.PublicURL
	}
	if doc.PublicUrl, err = resolveRefs("gateway.publicURL", publicURL, vars); err != nil {
		return nil, err
	}
	if doc.Identity.Issuer, err = resolveRefs("identity.issuer", env.Identity.Issuer, vars); err != nil {
		return nil, err
	}
	doc.Identity.SubjectClaim = env.Identity.SubjectClaim

	doc.Archivist.Host, doc.Archivist.Port = addr, semiontDescriptor("archivist").ports[0].port
	if env.Archivist != nil && env.Archivist.Host != "" {
		if doc.Archivist.Host, err = resolveRefs("archivist.host", env.Archivist.Host, vars); err != nil {
			return nil, err
		}
		if env.Archivist.Port != 0 {
			doc.Archivist.Port = env.Archivist.Port
		}
	}

	doc.Signal.Type = "in-process"
	if env.Signal != nil && env.Signal.Type == "nats" {
		doc.Signal.Type = "nats"
		servers, err := resolveRefs("signal.servers", env.Signal.Servers, vars)
		if err != nil {
			return nil, err
		}
		doc.Signal.Servers = &servers
		if doc.Signal.UserEnv, err = secretName("signal.user", env.Signal.User); err != nil {
			return nil, err
		}
		if doc.Signal.PasswordEnv, err = secretName("signal.password", env.Signal.Password); err != nil {
			return nil, err
		}
	}

	doc.LogLevel = "info"
	if env.LogLevel != "" {
		doc.LogLevel = semiont.GatewayConfigLogLevel(env.LogLevel)
	}
	doc.LogFormat = semiont.Json

	// Its capacity follows from the memory its container is given: half for
	// the bytes queued to its streams, and the other half at a connection
	// allowance each.
	memory := int(memCeilingGB(semiontDescriptor("gateway").mem) * (1 << 30))
	doc.Capacity.QueuedBytes = memory / 2
	doc.Capacity.Connections = memory / 2 / connectionAllowance
	return json.MarshalIndent(doc, "", "  ")
}
