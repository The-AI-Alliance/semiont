package launcher

// dispatcherdoc.go — the dispatcher's configuration document: DispatcherConfig
// in specs/, the Go type generated from it (packages/sdk-go). The launcher
// writes it for the dispatcher it starts, every address a literal
// (placement), and mounts it where the dispatcher's image points its
// `--config` flag, so the dispatcher neither reads a knowledge base's
// documents nor resolves or defaults anything. Secrets are never values in
// it: a broker credential is a variable the KnowledgeBase names (`fromEnv`),
// and the document names it.

import (
	"encoding/json"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// dispatcherDocumentFile: the dispatcher is configured by a document, not a
// copy of the KB's. One name, staged and mounted.
const dispatcherDocumentFile = "dispatcher.json"

// dispatcherDocumentTarget: where the dispatcher reads that document — the
// path its image passes to `--config`. TestConfigDocumentsAreWhereTheImagesLook
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

// dispatcherSecrets: the variables the dispatcher's document names, and so the
// ones it is handed — the pair of a broker somebody else runs. The pair of the
// broker the launcher runs is the launcher's own (withDaemonCredentialVars).
func dispatcherSecrets(p placement) []string {
	external := p.st.KnowledgeBase.Spec.Messaging.External
	if external == nil {
		return nil
	}
	return []string{external.User.FromEnv, external.Password.FromEnv}
}

// dispatcherDocument renders the document from the start's placement.
func dispatcherDocument(p placement) ([]byte, error) {
	kb := p.st.KnowledgeBase.Spec
	var doc semiont.DispatcherConfig
	doc.GatewayUrl = p.gatewayURL()
	doc.Identity.Issuer = p.issuer()
	doc.Queue.Servers = p.brokerServers()
	if p.placed("messaging") {
		// The broker the launcher runs has the pair the launcher generates
		// and keeps; the dispatcher is handed both.
		user, password := "NATS_USER", daemonPasswords["messaging"].env
		doc.Queue.UserEnv, doc.Queue.PasswordEnv = &user, &password
	} else {
		external := kb.Messaging.External
		doc.Queue.UserEnv, doc.Queue.PasswordEnv = &external.User.FromEnv, &external.Password.FromEnv
	}
	doc.Port = semiontDescriptor("dispatcher").ports[0].port

	doc.Timing.TickMs = dispatcherTiming.tickMs
	doc.Timing.StaleRunningMs = dispatcherTiming.staleRunningMs
	doc.Timing.AckWaitMs = dispatcherTiming.ackWaitMs
	doc.Timing.RetentionMs = dispatcherTiming.retentionMs
	doc.Timing.RetentionSweepMs = dispatcherTiming.retentionSweepMs
	doc.Timing.ProgressWriteIntervalMs = dispatcherTiming.progressWriteIntervalMs
	doc.Timing.BootDeadlineMs = dispatcherTiming.bootDeadlineMs

	doc.LogLevel = kb.LogLevel
	doc.LogFormat = semiont.LogFormatJson
	return json.MarshalIndent(doc, "", "  ")
}
