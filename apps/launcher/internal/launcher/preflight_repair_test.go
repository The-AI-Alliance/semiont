package launcher

import (
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

// The refusal must name the repair that applies to THIS issuer.
//
// `semiont identity sync` reaches a realm the launcher runs and nothing else:
// it needs the admin password this root persisted, and it reconciles against
// `serviceClients`. Offering it for an issuer somebody else runs sends an
// operator to a command that cannot help them; withholding it for a realm the
// launcher runs leaves them to infer the one command that fixes it. The two
// branches are one bool apart, which is exactly how they come to be collapsed
// later — hence this test.
func TestPreflightIdentityNamesTheRepairForThisIssuer(t *testing.T) {
	// A realm that has the other clients but not the dispatcher: the shape a
	// realm imported before a service was added actually has.
	srv := stubIssuer(t, func(clientID string) (int, string) {
		if clientID == serviceClientID("dispatcher") {
			return http.StatusUnauthorized, `{"error":"invalid_client"}`
		}
		return http.StatusOK, grantBody(map[string]any{
			"roles": stampedRoles(clientID),
			"aud":   testAudience,
		})
	})

	for _, tc := range []struct {
		name    string
		managed bool
		want    []string
		absent  []string
	}{
		{
			name:    "a realm this launcher runs",
			managed: true,
			want:    []string{"semiont-dispatcher", "semiont identity sync", "semiont start"},
			// The foreign-issuer instructions are noise here: there is no
			// client for the operator to create by hand.
			absent: []string{"SEMIONT_OIDC_CLIENT_SECRET_"},
		},
		{
			name:    "an issuer somebody else runs",
			managed: false,
			want:    []string{"semiont-dispatcher", "SEMIONT_OIDC_CLIENT_SECRET_"},
			// Naming sync here would send them to a command that cannot
			// reach their realm and would fail on the missing admin password.
			absent: []string{"semiont identity sync"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := captureStderr(t, func() {
				x := &liveExec{u: NewUI(true)}
				if x.preflightIdentity(srv.URL, testAudience, testSecrets(), 0, tc.managed) {
					t.Fatal("a realm missing a service client passed the preflight")
				}
			})
			for _, s := range tc.want {
				if !strings.Contains(got, s) {
					t.Errorf("refusal does not name %q:\n%s", s, got)
				}
			}
			for _, s := range tc.absent {
				if strings.Contains(got, s) {
					t.Errorf("refusal names %q, which does not apply to this issuer:\n%s", s, got)
				}
			}
		})
	}
}

// EXTRACT-JOBS P0: a worker whose token lacks the worker role authenticates
// perfectly and can never claim a job. The refusal must say which client and
// what it cannot do, and — for a realm this launcher runs — that `semiont
// identity sync` reconciles the client's roles mapper, then `semiont start`.
// For an issuer somebody else runs the role is theirs to grant, and sync must
// not be named. (The role string equals the worker's client id, so the text is
// asserted on "claim", not on the role.)
func TestPreflightIdentityNamesTheRepairForARoleLessWorker(t *testing.T) {
	srv := stubIssuer(t, func(clientID string) (int, string) {
		roles := stampedRoles(clientID)
		if clientID == serviceClientID("worker") {
			roles = []string{serviceRole} // the pre-P0 mapper value
		}
		return http.StatusOK, grantBody(map[string]any{"roles": roles, "aud": testAudience})
	})

	for _, tc := range []struct {
		name    string
		managed bool
		want    []string
		absent  []string
	}{
		{
			name:    "a realm this launcher runs",
			managed: true,
			want:    []string{serviceClientID("worker"), "claim", "semiont identity sync", "semiont start"},
		},
		{
			name:    "an issuer somebody else runs",
			managed: false,
			want:    []string{serviceClientID("worker"), "claim"},
			absent:  []string{"semiont identity sync"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := captureStderr(t, func() {
				x := &liveExec{u: NewUI(true)}
				if x.preflightIdentity(srv.URL, testAudience, testSecrets(), 0, tc.managed) {
					t.Fatal("a realm whose worker cannot claim passed the preflight")
				}
			})
			for _, s := range tc.want {
				if !strings.Contains(got, s) {
					t.Errorf("refusal does not name %q:\n%s", s, got)
				}
			}
			for _, s := range tc.absent {
				if strings.Contains(got, s) {
					t.Errorf("refusal names %q, which does not apply to this issuer:\n%s", s, got)
				}
			}
		})
	}
}

// captureStderr: the refusal is written to stderr rather than returned, so the
// only way to assert on it is to read it.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	old := os.Stderr
	os.Stderr = w
	defer func() { os.Stderr = old }()

	fn()
	_ = w.Close()
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(b)
}
