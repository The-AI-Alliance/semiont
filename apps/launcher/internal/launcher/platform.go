package launcher

// platform.go — the substrate a stack lives on (LAUNCHER-SERVICE-MODEL D5).
//
// A platform determines the MECHANISM by which a service comes to exist, and
// it may itself require provisioning before any service can exist on it at
// all: `gh codespace create` for a codespace, nothing for local.
//
// `runtime` — container, docker, podman — is NOT a sibling axis. Those are
// argv variants of ONE mechanism, running a container, and they are a
// parameter of that mechanism rather than a choice about where the stack
// lives. Only `local` has one.
//
// This used to be a value inside `Runtime`, which meant every reader of that
// field had to know that one of the runtimes was not a runtime — and the
// launcher then had to refuse, by hand and one flag at a time, every local
// knob that a codespace start cannot honour.
type platform string

const (
	// platformLocal: containers on this machine, through a runtime.
	platformLocal platform = "local"
	// platformCodespace: a GitHub-hosted machine. The launcher provisions it
	// and forwards a port; compose owns the services INSIDE it, which is why
	// so many local flags have nothing to act on there.
	platformCodespace platform = "codespace"
)

// runtimeFlagPlatform: the `--runtime` spellings that name a PLATFORM rather
// than a container runtime. The flag keeps one name for both because that is
// what users type; the two meanings part company here, once, instead of at
// every site that used to compare a runtime against "codespace".
func runtimeFlagPlatform(v string) (platform, bool) {
	if v == string(platformCodespace) {
		return platformCodespace, true
	}
	return platformLocal, false
}
