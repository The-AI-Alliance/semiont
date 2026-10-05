package launcher

import (
	"fmt"
	"os"
	"strings"
)

// useraddHint renders the "run this next" command a successful start prints.
// Every such line is BUILT here rather than typed at the call site, because
// typed ones drift: a summary advertising a flag useradd refuses makes a
// fresh install's first instruction a command that fails. Built in one
// place, a flag that does not exist cannot be spelled.
func useraddHint(repo string) string {
	cmd := "semiont useradd"
	if repo != "" {
		cmd += " --repo " + repo
	}
	return cmd + " --email <email>"
}

const useraddUsage = `Usage: semiont useradd --email <email> [--generate-password] [options]

Create or update a user in a Semiont stack, local or codespace. The ISSUER holds
the account, the profile and the password; this decides which realm is meant and
speaks to it. A local realm is administered from here; a codespace's by its own
launcher, over ssh, so that machine's admin credential never crosses the wire.

The password is never typed as an argument. Creating a user prompts for one on
a terminal, or reads it from stdin when piped:

  semiont useradd --email admin@example.com               # prompts
  cat pw | semiont useradd --email bot@example.com        # scripted

Options:

  --email <email>       User email address (required)
  --generate-password   Generate a random 16-char password (printed once)
  --inactive            Disable the account at the identity provider
  --active              Re-enable a disabled account
  --update              Update an existing user
  --upsert              Create if absent, succeed silently if present
  --password-stdin      Set the password (implied when creating; say it
                        explicitly with --update to CHANGE a password)

Creating an account prints the identity it acts under. On a terminal, it then
says how the person signs in.

There are no role flags. No Semiont route grants access on the basis of a role,
so there is nothing here to grant. There is no display name either: the realm
requires a first and last name, and asks the person for their own at first
sign-in rather than have an administrator guess how to split one string.

Launcher-owned (consumed here, not forwarded):

  --repo <owner/name>   Target that codespace stack
  --runtime <name>      Target the LOCAL stack (selector only, as in stop)
  --help, -h            Show this help

Needs a started stack: the realm is reached at the issuer this KB configures,
and semiont start is what records which config that is. With more than one
stack recorded, the working directory disambiguates (the clone whose local stack
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

// Useradd implements `semiont useradd`. The ISSUER owns the account, the
// profile and the password hashing; this decides which realm is meant and
// speaks to it.
//
// A LOCAL stack is administered here, through the same admin client
// `identity sync` uses — no container, and the gateway need not be running.
// A CODESPACE runs its OWN launcher over ssh, for the same reason: the remote
// realm's admin password lives in that machine's environment and never crosses
// the wire.
//
// The password NEVER travels in argv, nor as a container env var. An env var
// is readable via `inspect` for the stack's whole lifetime; an exec argument
// can be redacted in the echo, but redaction is cosmetic: `ps` shows any
// process's command line to every user on the host, and the caller's shell
// writes it to history besides. The launcher reads it (prompting on a
// terminal, else from stdin) and pipes it to `--password-stdin`, so it exists
// only in two process memories and the pipe between them.
func Useradd(args []string) int {
	u := NewUI(false)
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

	// Every flag is READ here — the local path acts on them directly — and
	// every flag but --repo and --runtime is also FORWARDED, because the
	// codespace path hands them to the codespace's own launcher. --repo and
	// --runtime select a stack and never cross.
	repo, wantLocal := "", false
	generate, update, wantStdin := false, false, false
	o := useraddOpts{}
	rest := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--email":
			if i+1 >= len(args) {
				u.Fail("Missing value for --email")
				return 1
			}
			o.email = args[i+1]
		case "--upsert":
			o.upsert = true
		case "--active":
			o.active = true
		case "--inactive":
			o.inactive = true
		case "--repo":
			if i+1 >= len(args) {
				u.Fail("Missing value for --repo")
				return 1
			}
			repo = args[i+1]
			i++
			continue
		case "--runtime": // selector only, mirroring stop: "the local stack"
			if i+1 >= len(args) {
				u.Fail("Missing value for --runtime")
				return 1
			}
			wantLocal = true
			i++
			continue
		case "--password":
			// Refused: it puts the secret in argv — visible in `ps` on the
			// host and in the container, kept by the runtime's container
			// record, and written to the caller's shell history.
			u.Fail("--password is no longer accepted: a password in argv is visible to every process on the host.")
			fmt.Fprintln(os.Stderr, "  Let it prompt:   semiont useradd --email <email>")
			fmt.Fprintln(os.Stderr, "  Or pipe it:      cat pw | semiont useradd --email <email>")
			fmt.Fprintln(os.Stderr, "  Or generate it:  semiont useradd --email <email> --generate-password")
			return 1
		case "--generate-password":
			generate = true
			o.generate = true
		case "--update":
			update = true
			o.update = true
		case "--password-stdin":
			wantStdin = true
			o.stdin = true
			continue // re-added below, exactly once
		default:
			// An unknown flag is REFUSED, not forwarded: this is the far end
			// for a local stack, and silently ignoring one would let
			// `--admin` — which grants nothing — look like it worked.
			if strings.HasPrefix(args[i], "--") {
				u.Fail("Unknown flag: %s", args[i])
				fmt.Fprintln(os.Stderr, "  See:  semiont useradd --help")
				return 1
			}
		}
		rest = append(rest, args[i])
	}

	// Asking for both a password and a generated one is a contradiction, and
	// it must be REFUSED here: --password-stdin is stripped above and re-added
	// only when a password is actually read, so forwarding alone would let the
	// far end's own mutual-exclusion check never see the pair — the user would
	// silently get a generated password they did not ask to keep.
	if generate && wantStdin {
		u.Fail("--password-stdin and --generate-password are contradictory: one supplies a password, the other invents one.")
		return 1
	}
	if !useraddValidate(u, o) {
		return 1
	}

	// Which stack? The shared knowledge-verb ladder (stackselect.go). The one
	// it selects is the one administered: for the local stack, its recorded
	// root decides the config, the issuer port and the admin password — not
	// the current directory, which may be another knowledge base entirely.
	stacks := LoadStackSet()
	target, ok := SelectVerbStack(u, "useradd", stacks, repo, wantLocal)
	if !ok {
		return 1
	}
	localRoot := ""
	if target == nil {
		if local := stacks.Stacks["local"]; local != nil {
			localRoot = local.KBRoot
		}
		if localRoot == "" {
			u.Fail("No local stack is running, so there is no realm to administer.")
			fmt.Fprintln(os.Stderr, "  Start it first:  semiont start")
			return 1
		}
	}

	// The password is read LAST, after every refusal this command can make.
	// Nobody should be asked to type a secret by an invocation that was
	// already going to be rejected for contradictory flags or a missing
	// gateway — the prompt would also bury the actual error.
	//
	// Who supplies it? The realm requires one only to CREATE, so an --update
	// that isn't explicitly changing the password needs none, and
	// --generate-password means the launcher that writes the account invents
	// it (applyUseradd) — on a codespace, the codespace's own launcher.
	password := ""
	if !generate && (!update || wantStdin) {
		pw, ok := readPassword(u)
		if !ok {
			return 1
		}
		password = pw
		rest = append(rest, "--password-stdin")
	}

	// The next steps are for a person reading a terminal. Over ssh the
	// codespace's own launcher writes to a pipe and prints none, so the lines
	// the person sees name the stack the way they selected it here.
	if target != nil {
		code := useraddCodespace(u, target, rest, password)
		if code == 0 && !update && !o.inactive && !o.upsert && stdoutIsTerminal() {
			printLines(useraddNextSteps(target, nil))
		}
		return code
	}
	code, created := useraddLocal(u, o, password, localRoot)
	if code == 0 && created && !o.inactive && stdoutIsTerminal() {
		printLines(useraddNextSteps(nil, stacks.Stacks["local"]))
	}
	return code
}

// stdoutIsTerminal: whether a person is reading stdout, not a pipe or a file.
func stdoutIsTerminal() bool {
	fi, err := os.Stdout.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

func printLines(lines []string) {
	for _, l := range lines {
		fmt.Println(l)
	}
}

// useraddValidate: the mutual exclusions and the one format check. They belong
// here rather than at the far end because a refusal the caller can make is one
// the caller should make — and on the codespace path the far end is an ssh hop
// away.
func useraddValidate(u *UI, o useraddOpts) bool {
	if o.email == "" {
		u.Fail("--email is required")
		return false
	}
	if !strings.Contains(o.email, "@") || strings.ContainsAny(o.email, " \t") ||
		!strings.Contains(o.email[strings.Index(o.email, "@"):], ".") {
		u.Fail("invalid email format: %s", o.email)
		return false
	}
	if o.update && o.upsert {
		u.Fail("--update and --upsert are contradictory: one demands the account exist, the other tolerates it.")
		return false
	}
	if o.inactive && o.active {
		u.Fail("--inactive and --active are contradictory.")
		return false
	}
	return true
}

// useraddCodespace runs the same verb one hop further out: ssh into the
// codespace and run ITS launcher, which administers that stack's realm exactly
// as this one administers a local stack.
//
// The realm's admin password never crosses the wire. It lives in the
// codespace's own environment, and the launcher over there reads it from there
// — this machine neither holds it nor needs to.
//
// CRITICAL: `gh codespace ssh -- cmd` runs the remote side through a SHELL
// (a `/workspaces/*` glob expands there, which is how the KB root is
// reached). So every argument is single-quote escaped before it
// crosses. The password is exempt by never being an argument: it goes down
// ssh's stdin to `--password-stdin`.
func useraddCodespace(u *UI, st *StackState, args []string, password string) int {
	if !requireGh(u, "useradd against a codespace stack") {
		return 1
	}
	// Build the remote command ONCE, and echo that same string — the
	// launcher's echoed lines are meant to be the exact command it runs (the
	// same contract --dry-run keeps). Echoing the pre-quoting args instead
	// would print something that behaves differently if pasted: $VARs would
	// expand and values with spaces would split.
	remote := remoteUseraddCmd(args, password != "")
	sshArgs := []string{"codespace", "ssh", "-c", st.Codespace.Name, "--", remote}
	u.Log("useradd on %s %s", u.Bold(st.Codespace.Repo), u.Dim("(codespace "+st.Codespace.Name+")"))
	u.EchoCmd("gh", "codespace", "ssh", "-c", st.Codespace.Name, "--", remote)
	if err := runVisibleWithStdin(password, "gh", sshArgs...); err != nil {
		u.Fail("useradd failed inside the codespace (see output above).")
		fmt.Fprintln(os.Stderr, "  Is the stack up?  semiont status --repo "+st.Codespace.Repo)
		return 1
	}
	return 0
}

// remoteUseraddCmd composes the command the codespace's shell will run: cd to
// the KB clone, then the launcher's own useradd. The glob is what the remote
// shell is for — a codespace mounts the repo under /workspaces/<name>, and the
// name is the repo's, not ours to guess.
//
// Nothing here carries a secret, so nothing needs redacting: the password goes
// by stdin, and the realm admin's password is already in that machine's
// environment.
func remoteUseraddCmd(args []string, _ bool) string {
	cmd := "cd /workspaces/* && semiont useradd"
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
