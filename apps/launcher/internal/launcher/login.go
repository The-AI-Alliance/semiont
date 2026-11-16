package launcher

// login.go — `semiont login`: authenticate against a running stack's
// backend (POST /api/tokens/password, via the generated packages/sdk-go
// client — the launcher's first use of it) and store the session token per
// stack (tokens.go). The password is read from STDIN only: prompted with
// echo off on a terminal, one piped line otherwise — never argv (ps, shell
// history), never env, never disk.

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

const loginUsage = `Usage: semiont login --email <address> [--repo <owner/name> | --runtime <rt>]

Authenticate against a running stack's backend and store the session token
(launcher state home, mode 0600). The password is read from STDIN —
prompted with echo off on a terminal, or piped for scripts:

  echo "$PASSWORD" | semiont login --email admin@example.com

Options:
  --email <address>    Account email (semiont useradd creates accounts)
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly
  --help               Show this help
`

func Login(args []string) int {
	u := newUI(false)
	email, repo, wantLocal := "", "", false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--email":
			if i+1 >= len(args) {
				u.fail("Missing value for --email")
				return 1
			}
			email = args[i+1]
			i++
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
			fmt.Print(loginUsage)
			return 0
		default:
			u.fail("Unknown argument: %s", args[i])
			return 1
		}
	}
	if email == "" {
		u.fail("Missing --email")
		fmt.Fprint(os.Stderr, loginUsage)
		return 1
	}

	ss := loadStackSet()
	target, ok := selectVerbStack(u, "login", ss, repo, wantLocal)
	if !ok {
		return 1
	}
	base, key := "", ""
	if target != nil {
		base = fmt.Sprintf("http://localhost:%d", target.ForwardPort)
		key = "codespace:" + target.Repo
	} else {
		local := ss.Stacks["local"]
		if local == nil {
			u.fail("login needs a running stack, and none is recorded.")
			fmt.Fprintln(os.Stderr, "  Start one first:  semiont start")
			return 1
		}
		base = backendBase(local)
		key = "local"
	}

	pw, ok := readPassword(u)
	if !ok {
		return 1
	}

	cli, err := semiont.NewClientWithResponses(base)
	if err != nil {
		u.fail("client: %v", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	resp, err := cli.PostApiTokensPasswordWithResponse(ctx, semiont.PasswordAuthRequest{
		Email:    openapi_types.Email(email),
		Password: pw,
	})
	if err != nil {
		u.fail("Backend unreachable at %s: %v", base, err)
		fmt.Fprintln(os.Stderr, "  Is the stack up?  semiont status")
		return 1
	}
	if resp.JSON401 != nil {
		u.fail("Invalid credentials for %s.", email)
		return 1
	}
	if resp.JSON200 == nil || resp.JSON200.Token == "" {
		u.fail("Login failed: HTTP %d.", resp.HTTPResponse.StatusCode)
		return 1
	}
	if err := saveToken(key, tokenEntry{
		Token:        resp.JSON200.Token,
		RefreshToken: resp.JSON200.RefreshToken,
		Email:        email,
		ObtainedAt:   time.Now().UTC(),
	}); err != nil {
		u.fail("Token could not be stored (%v) — NOT logged in.", err)
		return 1
	}
	u.ok("Logged in to %s as %s %s", key, email, u.dim("(token in "+tokensPath()+")"))
	return 0
}

// backendBase derives the API base URL from the local stack's recorded
// backend health endpoint — the record knows the real port even when the
// config moved it.
func backendBase(st *stackState) string {
	if e, ok := st.Services["backend"]; ok {
		if b, found := strings.CutSuffix(e.Endpoint, "/api/health"); found && b != "" {
			return b
		}
	}
	return "http://localhost:4000"
}

// readPassword reads one line from stdin. On a terminal the prompt goes to
// stderr and echo is disabled via stty (best-effort — no extra dependency);
// piped input is read as-is, which is the scripting path.
func readPassword(u *ui) (string, bool) {
	fi, err := os.Stdin.Stat()
	tty := err == nil && fi.Mode()&os.ModeCharDevice != 0
	if tty {
		fmt.Fprint(os.Stderr, "Password: ")
		off := exec.Command("stty", "-echo")
		off.Stdin = os.Stdin
		_ = off.Run()
		defer func() {
			on := exec.Command("stty", "echo")
			on.Stdin = os.Stdin
			_ = on.Run()
			fmt.Fprintln(os.Stderr)
		}()
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	pw := strings.TrimRight(line, "\r\n")
	if pw == "" {
		if err != nil {
			u.fail("No password on stdin.")
		} else {
			u.fail("Empty password.")
		}
		return "", false
	}
	return pw, true
}
