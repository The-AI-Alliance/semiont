package launcher

// session.go — the session lifecycle around login's stored tokens: the
// invisible refresh (access tokens live an hour; the stored 30-day refresh
// token renews them so login is a once-a-month event, not an hourly
// chore), and `semiont logout`.

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// refreshSession trades the stored refresh token for a fresh access token
// and SAVES the rotation — the next command must start from the new token.
// The server does not rotate the refresh token; the stored one is kept.
func refreshSession(u *ui, cli *semiont.ClientWithResponses, key string, e tokenEntry) (tokenEntry, bool) {
	if e.RefreshToken == "" {
		return e, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	resp, err := cli.PostApiTokensRefreshWithResponse(ctx, semiont.TokenRefreshRequest{
		RefreshToken: e.RefreshToken,
	})
	if err != nil || resp.JSON200 == nil || resp.JSON200.AccessToken == "" {
		return e, false
	}
	e.Token = resp.JSON200.AccessToken
	e.ObtainedAt = time.Now().UTC()
	if err := saveToken(key, e); err != nil {
		u.warn("Refreshed token could not be stored (%v) — it will work for this command only.", err)
	} else {
		u.log("Session refreshed %s", u.dim("(access token renewed from the stored refresh token)"))
	}
	return e, true
}

// verbSession resolves what every knowledge verb needs: which stack, its
// gateway base URL, and a live session token. One place, because nine verbs
// asking the same three questions nine different ways is how they drift.
// Refusals are printed here with their fix-it lines; ok=false means stop.
type verbTarget struct {
	base  string // gateway base URL (local record, or a codespace's forward)
	key   string // token/stack key: "local" or "codespace:<repo>"
	token string
	root  string // KB root, "" for a codespace target with no local clone
}

func verbSession(u *ui, verb, repo string, wantLocal bool) (verbTarget, bool) {
	ss := loadStackSet()
	target, ok := selectVerbStack(u, verb, ss, repo, wantLocal)
	if !ok {
		return verbTarget{}, false
	}
	var t verbTarget
	if target != nil {
		t.base = fmt.Sprintf("http://localhost:%d", target.ForwardPort)
		t.key = "codespace:" + target.Repo
		t.root = cwdKBRoot()
	} else {
		local := ss.Stacks["local"]
		if local == nil {
			u.fail("%s needs a running stack, and none is recorded.", verb)
			fmt.Fprintln(os.Stderr, "  Start one first:  semiont start")
			return verbTarget{}, false
		}
		t.base = gatewayBase(local)
		t.key = "local"
		t.root = local.KBRoot
		if t.root == "" {
			t.root = cwdKBRoot()
		}
	}
	e, have := loadTokens()[t.key]
	if !have || e.Token == "" {
		u.fail("No session for %s.", t.key)
		fmt.Fprintln(os.Stderr, "  Log in first:  semiont login --email <address>")
		return verbTarget{}, false
	}
	t.token = e.Token
	return t, true
}

const logoutUsage = `Usage: semiont logout [--repo <owner/name> | --runtime <rt>]

End the stack's stored session: best-effort server-side logout, then the
local token is forgotten either way.

Options:
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly
  --help               Show this help
`

func Logout(args []string) int {
	u := newUI(false)
	repo, wantLocal := "", false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--repo":
			if i+1 >= len(args) {
				u.fail("Missing value for --repo")
				return 1
			}
			repo = args[i+1]
			i++
		case "--runtime":
			if i+1 >= len(args) {
				u.fail("Missing value for --runtime")
				return 1
			}
			wantLocal = true
			i++
		case "--help", "-h":
			fmt.Print(logoutUsage)
			return 0
		default:
			u.fail("Unknown argument: %s", args[i])
			return 1
		}
	}

	ss := loadStackSet()
	target, ok := selectVerbStack(u, "logout", ss, repo, wantLocal)
	if !ok {
		return 1
	}
	base, key := "", ""
	if target != nil {
		base = fmt.Sprintf("http://localhost:%d", target.ForwardPort)
		key = "codespace:" + target.Repo
	} else {
		key = "local"
		if local := ss.Stacks["local"]; local != nil {
			base = gatewayBase(local)
		}
	}

	e, have := loadTokens()[key]
	if !have {
		u.log("No session for %s — nothing to log out.", key)
		return 0
	}
	// Server-side first, best-effort: an unreachable stack must not trap
	// the user in a session they asked to end — but say what it means.
	serverOut := false
	if base != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if cli, err := semiont.NewClientWithResponses(base); err == nil {
			if resp, err := cli.PostApiUsersLogoutWithResponse(ctx, bearer(e.Token)); err == nil && resp.HTTPResponse.StatusCode == 204 {
				serverOut = true
			}
		}
	}
	if err := deleteToken(key); err != nil {
		u.fail("Could not remove the stored session: %v", err)
		return 1
	}
	if serverOut {
		u.ok("Logged out of %s (%s) — session ended server-side, local token forgotten.", key, e.Email)
	} else {
		u.ok("Logged out of %s (%s) — local token forgotten.", key, e.Email)
		u.warn("Server-side logout did not complete; the token remains valid there until it expires (~1h).")
	}
	return 0
}

// bearer is the RequestEditorFn stamping the session's Authorization header.
func bearer(token string) semiont.RequestEditorFn {
	return func(_ context.Context, req *http.Request) error {
		req.Header.Set("Authorization", "Bearer "+token)
		return nil
	}
}
