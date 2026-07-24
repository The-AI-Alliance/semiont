package launcher

import (
	"fmt"
	"os"
	"strings"
)

const useraddUsage = `Usage: semiont useradd --email <email> (--password <pass> | --generate-password) [options]

Create or update a user in a RUNNING Semiont stack, local or codespace. The
launcher execs the Semiont CLI inside the backend container ('semiont' there
is the knowledge-work CLI; this launcher is the stack operator) and passes
every other flag through verbatim. Options the in-container CLI understands:

  --email <email>       User email address (required)
  --password <pass>     Password (min 8 characters)
  --generate-password   Generate a random 16-char password (printed once)
  --name <name>         Display name
  --admin               Grant admin privileges
  --moderator           Grant moderator privileges
  --inactive            Create the user inactive
  --update              Update an existing user
  --upsert              Create if absent, succeed silently if present

Launcher-owned (consumed here, not forwarded):

  --repo <owner/name>   Target that codespace stack
  --runtime <name>      Target the LOCAL stack (selector only, as in stop)
  --help, -h            Show this help

Needs a running backend: semiont start first. With more than one stack
recorded, the working directory disambiguates (the clone whose local stack
is running means local; a clone whose origin names a codespace stack, with
no local stack, means that one) — anywhere less certain, useradd refuses to
guess: say which with --repo or --runtime.

A codespace generates its FIRST admin at creation — semiont status prints
those credentials. Use useradd there for everything after that: more users,
role grants, password changes.

Examples:
  # First admin after a fresh local start
  semiont useradd --email admin@example.com --password <pass> --admin

  # A second user on a codespace KB
  semiont useradd --repo The-AI-Alliance/my-kb --email alice@example.com --generate-password
`

// Useradd implements `semiont useradd` — a thin exec bridge to the
// in-container CLI's useradd (the same verb the backend entrypoint runs for
// its worker user). The launcher contributes only what it knows: which stack
// is meant, and the sharpest handle into its backend. Everything else passes
// through verbatim — the in-container CLI owns validation, hashing, and the
// database write.
//
// This replaced `start --email/--password`: the admin password used to ride
// into the backend container as an env var, readable via `inspect` for the
// stack's whole lifetime. Here it exists only in one exec's argv (redacted
// in the echoed command and the invocation log).
func Useradd(args []string) int {
	u := newUI(false)
	for _, a := range args {
		if a == "--help" || a == "-h" {
			fmt.Print(useraddUsage)
			return 0
		}
	}
	if len(args) == 0 {
		fmt.Print(useraddUsage)
		return 1
	}

	// --repo and --runtime are the ONLY flags the launcher consumes rather
	// than forwards (they select a stack); everything else stays verbatim so
	// the in-container CLI can grow flags without touching this file.
	repo, wantLocal := "", false
	rest := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--repo":
			if i+1 >= len(args) {
				u.fail("Missing value for --repo")
				return 1
			}
			repo = args[i+1]
			i++
			continue
		case "--runtime": // selector only, mirroring stop: "the local stack"
			if i+1 >= len(args) {
				u.fail("Missing value for --runtime")
				return 1
			}
			wantLocal = true
			i++
			continue
		}
		rest = append(rest, args[i])
	}
	if repo != "" && wantLocal {
		u.fail("--repo and --runtime are contradictory: one names a codespace stack, the other the local one.")
		return 1
	}

	// Which stack? The shared knowledge-verb ladder (stackselect.go).
	target, ok := selectVerbStack(u, "useradd", loadStackSet(), repo, wantLocal)
	if !ok {
		return 1
	}

	if target != nil {
		return useraddCodespace(u, target, rest)
	}

	rt, handle := backendHandle()
	if rt == "" {
		u.fail("useradd needs a running backend, and none was found under any installed runtime.")
		fmt.Fprintln(os.Stderr, "  Start the stack first:  semiont start")
		return 1
	}
	execArgs := append([]string{"exec", handle, "semiont", "useradd"}, rest...)
	u.echoCmd(rt, execArgs...)
	if err := runVisible(rt, execArgs...); err != nil {
		u.fail("useradd failed inside the backend container (see output above).")
		return 1
	}
	return 0
}

// useraddCodespace runs the same verb one hop further out: through ssh into
// the codespace, then docker exec into its backend.
//
// CRITICAL: `gh codespace ssh -- cmd` runs the remote side through a SHELL
// (proven live — a `/workspaces/*` glob expands there). The local path has
// no shell, so passing argv straight through is safe there; here it is not.
// An unquoted password containing a space, $, quote or backtick would be
// mangled or would inject shell into the user's own codespace. So every
// argument is single-quote escaped before it crosses the wire.
func useraddCodespace(u *ui, st *stackState, args []string) int {
	if !requireGh(u, "useradd against a codespace stack") {
		return 1
	}
	// Build the remote command ONCE, and echo that same string — the
	// launcher's echoed lines are meant to be the exact command it runs (the
	// same contract --dry-run keeps). Echoing the pre-quoting args instead
	// would print something that behaves differently if pasted: $VARs would
	// expand and values with spaces would split.
	remote := remoteUseraddCmd(args, false)
	sshArgs := []string{"codespace", "ssh", "-c", st.Codespace, "--", remote}
	u.log("useradd on %s %s", u.bold(st.Repo), u.dim("(codespace "+st.Codespace+")"))
	// echoCmd's --password redaction can't see inside a composed string, so
	// the redacted variant is composed the same way instead.
	u.echoCmd("gh", "codespace", "ssh", "-c", st.Codespace, "--", remoteUseraddCmd(args, true))
	if err := runVisible("gh", sshArgs...); err != nil {
		u.fail("useradd failed inside the codespace's backend (see output above).")
		fmt.Fprintln(os.Stderr, "  Is the stack up?  semiont status --repo "+st.Repo)
		return 1
	}
	return 0
}

// remoteUseraddCmd composes the command the codespace's shell will run. With
// redact set, the --password VALUE is replaced before quoting, so the echoed
// string is otherwise identical to the real one.
func remoteUseraddCmd(args []string, redact bool) string {
	cmd := "docker exec semiont-backend semiont useradd"
	for i, a := range args {
		v := a
		if redact && i > 0 && args[i-1] == "--password" {
			v = "<redacted>"
		}
		cmd += " " + shellQuote(v)
	}
	return cmd
}

// shellQuote wraps a value for a POSIX shell: single quotes protect
// everything except a single quote itself, which is closed, escaped, and
// reopened. Nothing inside can be interpreted as shell syntax.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// backendHandle finds the runtime running the stack and the sharpest handle
// for its backend container: the record's runtime + ID when present (and
// that runtime is installed), else the name under whichever runtime's
// listing shows semiont-backend.
func backendHandle() (rt, handle string) {
	if st := loadLocalState(); st != nil && st.Runtime != "" && onPath(st.Runtime) {
		if e, ok := st.Services["backend"]; ok && e.Provided == providedLauncher {
			if e.ID != "" {
				return st.Runtime, e.ID
			}
			return st.Runtime, "semiont-backend"
		}
	}
	if rt := stackRuntime(); rt != "" {
		return rt, "semiont-backend"
	}
	return "", ""
}
