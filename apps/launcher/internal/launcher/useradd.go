package launcher

import (
	"fmt"
	"os"
	"strings"
)

const useraddUsage = `Usage: semiont useradd --email <email> [--generate-password] [options]

Create or update a user in a RUNNING Semiont stack, local or codespace. The
launcher execs 'semiont-useradd' inside the gateway container and passes every
other flag through verbatim — the ISSUER holds the account, the profile and the
password; this launcher only decides which stack is meant.

The password is never typed as an argument. Creating a user prompts for one on
a terminal, or reads it from stdin when piped:

  semiont useradd --email admin@example.com               # prompts
  cat pw | semiont useradd --email bot@example.com        # scripted

Options that command understands (its own --help is authoritative; this list
restates apps/gateway/src/cli/useradd.ts and an unknown flag is refused there):

  --email <email>       User email address (required)
  --generate-password   Generate a random 16-char password (printed once)
  --inactive            Disable the account at the identity provider
  --active              Re-enable a disabled account
  --update              Update an existing user
  --upsert              Create if absent, succeed silently if present
  --password-stdin      Set the password (implied when creating; say it
                        explicitly with --update to CHANGE a password)

There are no role flags. No Semiont route grants access on the basis of a role,
so there is nothing here to grant. There is no display name either: the realm
requires a first and last name, and asks the person for their own at first
sign-in rather than have an administrator guess how to split one string.

Launcher-owned (consumed here, not forwarded):

  --repo <owner/name>   Target that codespace stack
  --runtime <name>      Target the LOCAL stack (selector only, as in stop)
  --help, -h            Show this help

Needs a running gateway: semiont start first. With more than one stack
recorded, the working directory disambiguates (the clone whose local stack
is running means local; a clone whose origin names a codespace stack, with
no local stack, means that one) — anywhere less certain, useradd refuses to
guess: say which with --repo or --runtime.

NOTHING auto-creates an account — local and codespace alike. A fresh realm has
no users at all, so this is how the first one comes to exist, and how every
later user and password change happens.

Examples:
  # First user after a fresh local start (prompts for the password)
  semiont useradd --email admin@example.com

  # A second user on a codespace KB
  semiont useradd --repo The-AI-Alliance/my-kb --email alice@example.com --generate-password
`

// Useradd implements `semiont useradd` — a thin exec bridge to the gateway's
// own `semiont-useradd`. The launcher contributes only what it knows: which
// stack is meant, and the sharpest handle into its gateway. Everything else
// passes through verbatim — the ISSUER owns the account, the profile and the
// password hashing, and `semiont-useradd` is what speaks to it.
//
// It goes through the container rather than administering the realm directly
// on purpose. The gateway container is where the trusted issuer's URL is
// already resolved from the KB's config, and where the admin API client lives;
// an outside writer would have to re-derive both. Keeping the write with the
// process that already knows the issuer also keeps this launcher
// technology-agnostic: it runs containers, and need not know that Keycloak
// exists.
//
// (The exec target is the gateway image's own `semiont-useradd` bin, not a
// `semiont useradd` subcommand: there is no CLI inside the image to host one.)
//
// The password NEVER travels in argv. It used to ride into the container as an
// env var (readable via `inspect` for the stack's whole lifetime); then as an
// exec argument, redacted in the echo — but redaction is cosmetic: `ps` shows
// any process's command line to every user on the host, and the caller's shell
// wrote it to history besides. Now the launcher reads it (prompting on a
// terminal, else from stdin) and pipes it to `--password-stdin`, so it exists
// only in two process memories and the pipe between them.
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
	// `semiont-useradd` can grow flags without touching this file. The
	// password-bearing flags are READ here as well as forwarded, because the
	// launcher is what reads the password.
	repo, wantLocal := "", false
	generate, update, wantStdin := false, false, false
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
		case "--password":
			// Removed, not deprecated. It put the secret in argv — visible in
			// `ps` on the host and in the container, kept by the runtime's
			// container record, and written to the caller's shell history.
			u.fail("--password is no longer accepted: a password in argv is visible to every process on the host.")
			fmt.Fprintln(os.Stderr, "  Let it prompt:   semiont useradd --email <email>")
			fmt.Fprintln(os.Stderr, "  Or pipe it:      cat pw | semiont useradd --email <email>")
			fmt.Fprintln(os.Stderr, "  Or generate it:  semiont useradd --email <email> --generate-password")
			return 1
		case "--generate-password":
			generate = true
		case "--update":
			update = true
		case "--password-stdin":
			wantStdin = true
			continue // re-added below, exactly once
		}
		rest = append(rest, args[i])
	}

	// Asking for both a password and a generated one is a contradiction, and
	// it must be REFUSED here: --password-stdin is stripped above and re-added
	// only when a password is actually read, so forwarding alone would let the
	// gateway's own mutual-exclusion check never see the pair — the user would
	// silently get a generated password they did not ask to keep.
	if generate && wantStdin {
		u.fail("--password-stdin and --generate-password are contradictory: one supplies a password, the other invents one.")
		return 1
	}

	// Which stack? The shared knowledge-verb ladder (stackselect.go).
	target, ok := selectVerbStack(u, "useradd", loadStackSet(), repo, wantLocal)
	if !ok {
		return 1
	}

	rt, handle := "", ""
	if target == nil {
		if rt, handle = gatewayHandle(); rt == "" {
			u.fail("useradd needs a running gateway, and none was found under any installed runtime.")
			fmt.Fprintln(os.Stderr, "  Start the stack first:  semiont start")
			return 1
		}
	}

	// The password is read LAST, after every refusal this command can make.
	// Nobody should be asked to type a secret by an invocation that was
	// already going to be rejected for contradictory flags or a missing
	// gateway — the prompt would also bury the actual error.
	//
	// Who supplies it? The gateway requires one only to CREATE, so an --update
	// that isn't explicitly changing the password needs none, and
	// --generate-password means the gateway invents its own.
	password := ""
	if !generate && (!update || wantStdin) {
		pw, ok := readPassword(u)
		if !ok {
			return 1
		}
		password = pw
		rest = append(rest, "--password-stdin")
	}

	if target != nil {
		return useraddCodespace(u, target, rest, password)
	}
	// `semiont-useradd` is a bin the gateway package declares, linked onto PATH
	// by its image. -i attaches stdin so the password can cross that way; it is
	// omitted when there is no password to send, so the echoed command is the
	// exact command run in both cases.
	head := []string{"exec"}
	if password != "" {
		head = append(head, "-i")
	}
	// The realm administrator's credentials, for the one command that needs
	// them. They ride a ONE-SHOT exec rather than the gateway's own container
	// environment on purpose: a long-running service holding a credential that
	// can create any account is a far larger blast radius than a command that
	// exits. `redactEnvArgs` blanks the value in the echoed line, and when no
	// password is resolvable nothing is passed — the gateway then refuses and
	// names both variables, which is more use than a launcher-side guess about
	// whether this KB even has a realm.
	if secret, _ := keycloakAdminPassword(cwdKBRoot()); secret != "" {
		head = append(head,
			"--env", "KC_BOOTSTRAP_ADMIN_USERNAME="+keycloakAdminUser,
			"--env", "KC_BOOTSTRAP_ADMIN_PASSWORD="+secret)
	}
	execArgs := append(append(head, handle, "semiont-useradd"), rest...)
	u.echoCmd(rt, execArgs...)
	if err := runVisibleWithStdin(password, rt, execArgs...); err != nil {
		u.fail("useradd failed inside the gateway container (see output above).")
		return 1
	}
	return 0
}

// useraddCodespace runs the same verb one hop further out: through ssh into
// the codespace, then docker exec into its gateway.
//
// CRITICAL: `gh codespace ssh -- cmd` runs the remote side through a SHELL
// (proven live — a `/workspaces/*` glob expands there). The local path has no
// shell, so passing argv straight through is safe there; here it is not, and
// every argument is single-quote escaped before it crosses the wire.
//
// The password is exempt from all of that by never being an argument: it goes
// down ssh's stdin into `docker exec -i`. That removes the sharpest edge of
// this path — a password containing $, a backtick or a quote used to be one
// escaping bug away from injecting shell into the user's own codespace.
func useraddCodespace(u *ui, st *stackState, args []string, password string) int {
	if !requireGh(u, "useradd against a codespace stack") {
		return 1
	}
	// Build the remote command ONCE, and echo that same string — the
	// launcher's echoed lines are meant to be the exact command it runs (the
	// same contract --dry-run keeps). Echoing the pre-quoting args instead
	// would print something that behaves differently if pasted: $VARs would
	// expand and values with spaces would split.
	remote := remoteUseraddCmd(args, password != "")
	sshArgs := []string{"codespace", "ssh", "-c", st.Codespace, "--", remote}
	u.log("useradd on %s %s", u.bold(st.Repo), u.dim("(codespace "+st.Codespace+")"))
	u.echoCmd("gh", "codespace", "ssh", "-c", st.Codespace, "--", remote)
	if err := runVisibleWithStdin(password, "gh", sshArgs...); err != nil {
		u.fail("useradd failed inside the codespace's gateway (see output above).")
		fmt.Fprintln(os.Stderr, "  Is the stack up?  semiont status --repo "+st.Repo)
		return 1
	}
	return 0
}

// remoteUseraddCmd composes the command the codespace's shell will run. With
// stdin set, `docker exec -i` keeps the pipe attached through ssh so the
// password can arrive that way. Nothing here needs redacting any more: no
// argument carries a secret.
func remoteUseraddCmd(args []string, stdin bool) string {
	cmd := "docker exec"
	if stdin {
		cmd += " -i"
	}
	// The realm administrator's password is read from the CODESPACE's own
	// environment by the remote shell — written as a variable reference, never
	// a value, so this machine's secret never crosses the wire and there is
	// nothing in the echoed command to redact. Unset there, it arrives empty
	// and the gateway refuses by name.
	cmd += ` -e KC_BOOTSTRAP_ADMIN_USERNAME=` + shellQuote(keycloakAdminUser) +
		` -e KC_BOOTSTRAP_ADMIN_PASSWORD="$KC_BOOTSTRAP_ADMIN_PASSWORD"`
	cmd += " semiont-gateway semiont-useradd"
	for _, a := range args {
		cmd += " " + shellQuote(a)
	}
	return cmd
}

// shellQuote wraps a value for a POSIX shell: single quotes protect
// everything except a single quote itself, which is closed, escaped, and
// reopened. Nothing inside can be interpreted as shell syntax.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// gatewayHandle finds the runtime running the stack and the sharpest handle
// for its gateway container: the record's runtime + ID when present (and
// that runtime is installed), else the name under whichever runtime's
// listing shows semiont-gateway.
func gatewayHandle() (rt, handle string) {
	if st := loadLocalState(); st != nil && st.Runtime != "" && onPath(st.Runtime) {
		if e, ok := st.Services["gateway"]; ok && e.Provided == providedLauncher {
			if e.ID != "" {
				return st.Runtime, e.ID
			}
			return st.Runtime, "semiont-gateway"
		}
	}
	if rt := stackRuntime(); rt != "" {
		return rt, "semiont-gateway"
	}
	return "", ""
}
