package launcher

// discovery.go — lane 1 of BROWSER-KB-DISCOVERY.md: publish the launcher's
// KB view where the Browser can read it.
//
// SCHEMA AUTHORITY: specs/src/discovery/DiscoveryDocument.json (and
// DiscoveredKB.json) — the multi-language contract of record: a standalone
// contract directory in specs (per-directory ref-closure by rule, so binding
// it never drags in the API surface; see specs/src/discovery/README.md). TypeScript
// consumers get their types from @semiont/core (the OpenAPI pipeline); THIS
// side gets discovery_types_gen.go from the same files via the go:generate
// below — the Go equivalent of core's generated types.ts, so schema drift is
// a compile error here, not a review promise. Change the schema first, then
// regenerate both sides. version is the compatibility gate: consumers must
// ignore documents they do not understand.

//go:generate sh -c "cd ../../../.. && container run --rm -v $(pwd):/w -w /w golang:1.25 go run github.com/atombender/go-jsonschema@v0.23.1 -p launcher --tags json --struct-name-from-title --capitalization KB -o apps/launcher/internal/launcher/discovery_types_gen.go specs/src/discovery/DiscoveryDocument.json" <stateDir>/discovery/kbs.json is an
// EXPORT VIEW regenerated on every stack mutation (saveStackSet is the single
// writer), and the frontend container mounts the directory read-only at
// /discovery. Never stack.json itself — that file is launcher-private (PIDs,
// staging paths) — and never a secret or credential: endpoints only, login
// stays the Browser's per-KB business.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// writeDiscovery renders the view. An EMPTY stack set writes an empty list —
// an absent file is ambiguous ("no launcher?" vs "nothing running"), an
// empty list says plainly that the launcher manages nothing right now.
func writeDiscovery(ss *stackSet) {
	dir := stateDir()
	if dir == "" {
		return
	}
	opt := func(v string) *string {
		if v == "" {
			return nil
		}
		return &v
	}
	kbs := []DiscoveredKB{}
	if st := ss.Stacks["local"]; st != nil {
		e := DiscoveredKB{Host: "localhost", Port: 4000, Placement: DiscoveredKBPlacementLocal,
			Did: opt(st.KBDid), ManagedBy: "semiont-launcher"}
		// The backend endpoint carries the real port when the config moved it.
		if b, ok := st.Services["backend"]; ok {
			if p := portFromEndpoint(b.Endpoint); p != 0 {
				e.Port = p
			}
		}
		if ident := loadKBIdentity(st.KBRoot); ident != nil {
			e.SiteName = opt(ident.SiteName)
		}
		kbs = append(kbs, e)
	}
	for _, c := range codespaceStacks(ss) {
		if c.ForwardPort == 0 {
			continue // no local endpoint to offer
		}
		kbs = append(kbs, DiscoveredKB{
			Host: "localhost", Port: c.ForwardPort, Placement: DiscoveredKBPlacementCodespace,
			Repo: opt(c.Repo), Did: opt(c.KBDid), ManagedBy: "semiont-launcher",
		})
	}
	b, err := json.MarshalIndent(DiscoveryDocument{Version: 1, Kbs: kbs}, "", "  ")
	if err != nil {
		return
	}
	ddir := filepath.Join(dir, "discovery")
	if os.MkdirAll(ddir, 0o755) != nil {
		return
	}
	tmp := filepath.Join(ddir, ".kbs.json.tmp")
	if os.WriteFile(tmp, append(b, '\n'), 0o644) != nil {
		return
	}
	_ = os.Rename(tmp, filepath.Join(ddir, "kbs.json"))
}

// portFromEndpoint digs the port out of a recorded health endpoint
// (http://localhost:4000/api/health, tcp:localhost:5432).
func portFromEndpoint(ep string) int {
	ep = strings.TrimPrefix(ep, "http://")
	ep = strings.TrimPrefix(ep, "https://")
	ep = strings.TrimPrefix(ep, "tcp:")
	if i := strings.IndexByte(ep, '/'); i >= 0 {
		ep = ep[:i]
	}
	if i := strings.LastIndexByte(ep, ':'); i >= 0 {
		n := 0
		for _, r := range ep[i+1:] {
			if r < '0' || r > '9' {
				return 0
			}
			n = n*10 + int(r-'0')
		}
		return n
	}
	return 0
}
