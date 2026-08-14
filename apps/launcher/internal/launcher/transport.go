package launcher

// transport.go — where verbs get their bus transport.
//
// Every knowledge verb used to construct its own `bus.Client`,
// which meant the only way to observe one was to run the real binary against a
// real HTTP server. One construction point, behind a swappable function, makes
// a verb testable in process (SDK-GO-TRANSPORT P1).
//
// This is the seam, not a factory: production has exactly one implementation
// and the indirection exists for substitutability, which is why it is a plain
// package-level func rather than a registry.

import "github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"

// newTransport builds the transport a verb talks to. Tests replace it via
// useTransport.
var newTransport = func(base, token string) bus.Transport { return bus.NewClient(base, token) }

// useTransport swaps the constructor and returns a restore func. Test-only by
// intent; it lives in the non-test file because the variable it closes over
// does, and Go has no narrower visibility that keeps them together.
func useTransport(f func(base, token string) bus.Transport) (restore func()) {
	prev := newTransport
	newTransport = f
	return func() { newTransport = prev }
}
