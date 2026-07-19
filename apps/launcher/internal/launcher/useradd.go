package launcher

import (
	"fmt"
	"os"
)

const useraddUsage = `Usage: semiont useradd --email <email> (--password <pass> | --generate-password) [options]

Create or update a user in the RUNNING Semiont stack. The launcher execs the
Semiont CLI inside the backend container ('semiont' there is the
knowledge-work CLI; this launcher is the stack operator) and passes every
flag through verbatim. Options the in-container CLI understands:

  --email <email>       User email address (required)
  --password <pass>     Password (min 8 characters)
  --generate-password   Generate a random 16-char password (printed once)
  --name <name>         Display name
  --admin               Grant admin privileges
  --moderator           Grant moderator privileges
  --inactive            Create the user inactive
  --update              Update an existing user
  --upsert              Create if absent, succeed silently if present
  --help, -h            Show this help

Needs a running backend: semiont start first.

Examples:
  # First admin after a fresh start
  semiont useradd --email admin@example.com --password <pass> --admin

  # A regular user with a generated password
  semiont useradd --email alice@example.com --generate-password
`

// Useradd implements `semiont useradd` — a thin exec bridge to the
// in-container CLI's useradd (the same verb the backend entrypoint runs for
// its worker user). The launcher contributes only what it knows: which
// runtime runs the stack (record first, name-scan fallback) and the
// sharpest backend handle. Flags pass through verbatim — the in-container
// CLI owns validation, hashing, and the database write.
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

	rt, handle := backendHandle()
	if rt == "" {
		u.fail("useradd needs a running backend, and none was found under any installed runtime.")
		fmt.Fprintln(os.Stderr, "  Start the stack first:  semiont start")
		return 1
	}
	execArgs := append([]string{"exec", handle, "semiont", "useradd"}, args...)
	u.echoCmd(rt, execArgs...)
	if err := runVisible(rt, execArgs...); err != nil {
		u.fail("useradd failed inside the backend container (see output above).")
		return 1
	}
	return 0
}

// backendHandle finds the runtime running the stack and the sharpest handle
// for its backend container: the record's runtime + ID when present (and
// that runtime is installed), else the name under whichever runtime's
// listing shows semiont-backend.
func backendHandle() (rt, handle string) {
	if st := loadState(); st != nil && st.Runtime != "" && onPath(st.Runtime) {
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
