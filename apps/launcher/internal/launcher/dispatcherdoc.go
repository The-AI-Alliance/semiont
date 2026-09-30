package launcher

// dispatcherdoc.go — the dispatcher's configuration document: DispatcherConfig
// in specs/, the Go type generated from it (packages/sdk-go). The launcher
// writes it for the dispatcher it starts, resolved — every ${VAR} a value — and
// mounts it where the dispatcher's image points its `--config` flag, so the
// dispatcher neither parses TOML nor resolves or defaults anything. Secrets are
// never values in it: a broker credential is a ${NAME} in the KB config, and
// the document names NAME.

import (
	"encoding/json"
	"fmt"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// dispatcherDocumentFile: the dispatcher is configured by a document, not a
// copy of the KB's config. One name, staged and mounted.
const dispatcherDocumentFile = "dispatcher.json"

// dispatcherDocumentTarget: where the dispatcher reads that document — the
// path its image passes to `--config`. TestDispatcherDocumentIsWhereTheImageLooks
// holds the two together.
const dispatcherDocumentTarget = "/etc/semiont/dispatcher.json"

// dispatcherTiming: the clocks a deployed dispatcher runs with. The launcher
// is the one decider: the dispatcher defaults none of them, and a test harness
// writes its own.
var dispatcherTiming = struct {
	tickMs, staleRunningMs, ackWaitMs, retentionMs, retentionSweepMs, progressWriteIntervalMs, bootDeadlineMs int
}{
	tickMs:                  30_000,
	staleRunningMs:          30 * 60_000,
	ackWaitMs:               30_000,
	retentionMs:             24 * 60 * 60_000,
	retentionSweepMs:        60 * 60_000,
	progressWriteIntervalMs: 5_000,
	bootDeadlineMs:          60_000,
}

// dispatcherNamedVars: the variables the dispatcher's document names rather
// than resolves — the broker pair the KB config writes as ${NAME}s — and so
// the ones the dispatcher is handed. A credential that is not exactly ${NAME}
// names nothing here; writing the document refuses it.
func dispatcherNamedVars(env *envConfig) []string {
	var names []string
	if env.Jobs == nil {
		return names
	}
	user, _ := secretName("jobs.user", env.Jobs.User)
	password, _ := secretName("jobs.password", env.Jobs.Password)
	for _, name := range []*string{user, password} {
		if name != nil {
			names = append(names, *name)
		}
	}
	return names
}

// dispatcherVars: what a ${VAR} in the dispatcher's settings resolves against —
// the gateway's set, plus the gateway's own host, which the dispatcher dials,
// set last as a sidecar's has always been (gatewayHostEnv follows the user's
// variables). The gateway's resolver omits it on purpose (gatewayVars): copied
// as it is, a ${GATEWAY_HOST:-localhost} in the dispatcher's gateway URL would
// resolve to the dispatcher's own container.
func dispatcherVars(rt, addr string, issuerPort int, userEnv []string) map[string]string {
	vars := gatewayVars(rt, addr, issuerPort, userEnv)
	vars["GATEWAY_HOST"] = addr
	vars["BACKEND_HOST"] = addr
	return vars
}

// dispatcherDocument renders the document from the selected environment, the
// address the launcher computed, and the user's variables. The dispatcher's
// queue is JetStream: a [jobs] section of any other type, or none, refuses,
// because a dispatcher holds no state tree for another driver to write.
func dispatcherDocument(env *envConfig, rt, addr string, issuerPort int, userEnv []string, brokerRun bool) ([]byte, error) {
	if env.Gateway == nil || env.Gateway.PublicURL == "" {
		return nil, fmt.Errorf("the environment declares no [gateway] publicURL: the dispatcher has no gateway to reach")
	}
	if env.Identity == nil {
		return nil, fmt.Errorf("the environment declares no [identity]: the dispatcher has no issuer to sign in at")
	}
	if env.Jobs == nil || env.Jobs.Type != "jetstream" {
		return nil, fmt.Errorf(`the dispatcher's queue is JetStream: the environment's [jobs] must set type = "jetstream"`)
	}
	vars := dispatcherVars(rt, addr, issuerPort, userEnv)
	var doc semiont.DispatcherConfig
	var err error
	if doc.GatewayUrl, err = resolveRefs("gateway.publicURL", env.Gateway.PublicURL, vars); err != nil {
		return nil, err
	}
	if doc.Identity.Issuer, err = resolveRefs("identity.issuer", env.Identity.Issuer, vars); err != nil {
		return nil, err
	}
	if doc.Queue.Servers, err = resolveRefs("jobs.servers", env.Jobs.Servers, vars); err != nil {
		return nil, err
	}
	if brokerRun {
		// The broker the launcher runs has the pair it keeps
		// (SECRET-DELIVERY P4); the dispatcher is handed both.
		user, password := "NATS_USER", daemonPasswords["messaging"].env
		doc.Queue.UserEnv, doc.Queue.PasswordEnv = &user, &password
	} else {
		if doc.Queue.UserEnv, err = secretName("jobs.user", env.Jobs.User); err != nil {
			return nil, err
		}
		if doc.Queue.PasswordEnv, err = secretName("jobs.password", env.Jobs.Password); err != nil {
			return nil, err
		}
	}
	doc.Port = semiontDescriptor("dispatcher").ports[0].port

	doc.Timing.TickMs = dispatcherTiming.tickMs
	doc.Timing.StaleRunningMs = dispatcherTiming.staleRunningMs
	doc.Timing.AckWaitMs = dispatcherTiming.ackWaitMs
	doc.Timing.RetentionMs = dispatcherTiming.retentionMs
	doc.Timing.RetentionSweepMs = dispatcherTiming.retentionSweepMs
	doc.Timing.ProgressWriteIntervalMs = dispatcherTiming.progressWriteIntervalMs
	doc.Timing.BootDeadlineMs = dispatcherTiming.bootDeadlineMs

	doc.LogLevel = "info"
	if env.LogLevel != "" {
		doc.LogLevel = semiont.DispatcherConfigLogLevel(env.LogLevel)
	}
	doc.LogFormat = semiont.DispatcherConfigLogFormatJson
	return json.MarshalIndent(doc, "", "  ")
}
