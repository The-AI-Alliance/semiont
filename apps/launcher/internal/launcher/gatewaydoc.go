package launcher

// gatewaydoc.go — the gateway's configuration document: GatewayConfig in
// specs/, the Go type generated from it (packages/sdk-go). The launcher
// writes it for the gateway it starts, resolved — every ${VAR} a value — so
// the gateway neither parses TOML nor resolves or defaults anything. Secrets
// are never values in it: a credential is a ${NAME} in the KB config, and the
// document names NAME.

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
func secretName(field, value string) (*string, error) {
	if value == "" {
		return nil, nil
	}
	name := referenceName(value)
	if name == "" {
		return nil, fmt.Errorf("%s must be a ${VAR} reference: a service's configuration document carries no secret value — set it in the environment and write %s = \"${NAME}\"", field, field)
	}
	return &name, nil
}

// gatewayNamedVars: the variables the gateway's document names rather than
// resolves — the broker pair — and so the ones the gateway is handed. A
// credential that is not exactly ${NAME} names nothing here; writing the
// document refuses it.
func gatewayNamedVars(env *envConfig) []string {
	var names []string
	if env.Signal == nil || env.Signal.Type != "nats" {
		return names
	}
	user, _ := secretName("signal.user", env.Signal.User)
	password, _ := secretName("signal.password", env.Signal.Password)
	for _, name := range []*string{user, password} {
		if name != nil {
			names = append(names, *name)
		}
	}
	return names
}

// gatewayVars: what a ${VAR} in the gateway's settings resolves against — the
// addresses the launcher places (topologyVars), and the user's own variables.
// GATEWAY_HOST is absent on purpose: the gateway is not handed it
// (gatewayArgs), so a ${GATEWAY_HOST:-…} in its publicURL takes its default.
func gatewayVars(rt, addr string, issuerPort int, userEnv []string) map[string]string {
	vars := topologyVars(rt, addr, issuerPort)
	for name, value := range userEnvVars(userEnv) {
		vars[name] = value
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
func gatewayDocument(env *envConfig, kbName, kbDomain, rt, addr string, issuerPort int, port int, userEnv []string, brokerRun bool) ([]byte, error) {
	if kbDomain == "" {
		return nil, fmt.Errorf("the knowledge base declares no [site] domain in its .semiont/config: the gateway has no identity to run under")
	}
	if env.Identity == nil {
		return nil, fmt.Errorf("the environment declares no [identity]: the gateway has no issuer to trust")
	}
	vars := gatewayVars(rt, addr, issuerPort, userEnv)
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
		if brokerRun {
			// The broker the launcher runs has the pair the launcher
			// generates and keeps; the gateway is handed both.
			user, password := "NATS_USER", daemonPasswords["messaging"].env
			doc.Signal.UserEnv, doc.Signal.PasswordEnv = &user, &password
		} else {
			if doc.Signal.UserEnv, err = secretName("signal.user", env.Signal.User); err != nil {
				return nil, err
			}
			if doc.Signal.PasswordEnv, err = secretName("signal.password", env.Signal.Password); err != nil {
				return nil, err
			}
		}
	}

	doc.LogLevel = "info"
	if env.LogLevel != "" {
		doc.LogLevel = semiont.LogLevel(env.LogLevel)
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

// externalCredential: an external daemon's credential as the config writes it,
// resolved by the shared rule against the user's variables — where the
// launcher itself needs the value. An unresolvable reference refuses, naming
// it.
func externalCredential(field, value string, userEnv []string) (string, error) {
	return resolveRefs(field, value, userEnvVars(userEnv))
}

// userEnvVars: the NAME=value pairs of a start's resolved --env list.
func userEnvVars(userEnv []string) map[string]string {
	vars := map[string]string{}
	for i := 0; i+1 < len(userEnv); i += 2 {
		if userEnv[i] == "--env" {
			if name, value, ok := strings.Cut(userEnv[i+1], "="); ok {
				vars[name] = value
			}
		}
	}
	return vars
}
