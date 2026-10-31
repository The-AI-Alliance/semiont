package launcher

// identitycmd.go — `semiont identity sync`, `grant` and `revoke`, the
// operator-facing half of identitysync.go and identitygrant.go.
//
// Resolution mirrors `start`'s exactly, and deliberately: each must change the
// realm THIS root would import, and sync reconciles it against the credentials
// THIS root would inject. Deriving either differently is how a repair produces
// a realm that still does not match the next start.

import (
	"fmt"
	"net/url"
	"os"
	"slices"
	"strings"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

const identityUsage = `Usage: semiont identity sync [--root <path>] [--config <name>]
       semiont identity grant <label> --key <file> [--root <path>] [--config <name>]
       semiont identity revoke <label> [--root <path>] [--config <name>]

sync
  Reconcile a running realm against what this knowledge base needs: the
  service-account clients and the roles their tokens carry, the loopback
  redirect URIs that let the Browser move port, the implicit flow (off), and
  the access-token lifetime.

  A realm is imported on its FIRST boot and never again, so a deployment that
  predates a service simply does not have that service's client — and one that
  predates a role still stamps the old roles on that client's token — and
  ` + "`semiont start`" + ` refuses, correctly, rather than starting processes
  that cannot authenticate, or a worker that can never claim a job. This adds
  and updates what the import would have rendered.

  It reconciles CONFIGURATION ONLY. It creates clients, updates an existing
  client's roles and kind mappers and the worker's client's key — this
  machine's, which ` + "`semiont worker key`" + ` prints — and changes nothing
  else: no secret is touched, and no accounts are read, written or deleted, so
  it is safe to run against a realm with real users. It is idempotent — run
  it again to confirm it worked.

grant
  Admit a worker someone else runs, by its key: the public half that
  ` + "`semiont worker key`" + ` prints on the worker's machine, as a JWK Set or
  a PEM, in <file>. It creates one client, semiont-worker-<label>, that proves
  itself with that key and carries the worker's roles, and prints what the
  worker's owner needs: this knowledge base's domain, its client id, and where
  the gateway is, which names the issuer to sign in at, and the one
  ` + "`semiont worker kb add`" + ` line that adds this knowledge base to their
  worker. None is secret. Granting the same key again changes nothing;
  another key under the same label replaces the old on the same client, so the
  worker keeps its account.

revoke
  Delete the client granted under <label>, and no other. The worker's next
  sign-in is refused; a token it already holds stays good until it expires,
  within the realm's access-token lifetime.

Each needs Keycloak's bootstrap admin password, the same one ` + "`semiont start`" + `
reports: $KC_BOOTSTRAP_ADMIN_PASSWORD, else the value persisted for this root.
None will generate one — a fresh password cannot open the realm an existing
database already holds.
`

func Identity(args []string) int {
	u := NewUI(false)
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Print(identityUsage)
		if len(args) == 0 {
			return 1
		}
		return 0
	}
	switch args[0] {
	case "sync":
		return identitySync(u, args[1:])
	case "grant":
		return identityGrant(u, args[1:])
	case "revoke":
		return identityRevoke(u, args[1:])
	}
	u.Fail("Unknown identity subcommand: %s", args[0])
	fmt.Fprint(os.Stderr, identityUsage)
	return 1
}

// subcommandArgs: what one subcommand was given — the flags it takes,
// and its positional arguments.
func subcommandArgs(u *UI, args []string, takes ...string) (map[string]string, []string, bool) {
	flags := map[string]string{}
	var positional []string
	for i := 0; i < len(args); i++ {
		if !strings.HasPrefix(args[i], "-") {
			positional = append(positional, args[i])
			continue
		}
		if !slices.Contains(takes, args[i]) {
			u.Fail("Unknown flag: %s", args[i])
			return nil, nil, false
		}
		if i+1 >= len(args) {
			u.Fail("Missing value for %s", args[i])
			return nil, nil, false
		}
		flags[args[i]] = args[i+1]
		i++
	}
	return flags, positional, true
}

// adminRealm: the realm a root's launcher-run Keycloak imports, resolved as
// `start` resolves it, and what administering it takes.
type adminRealm struct {
	kb        kbRoot
	st        *stack.Stack
	rp        rolePlan
	realm     string
	base      string // Keycloak's root, as this machine reaches it
	adminPass string
}

// openAdminRealm resolves the realm --root and --config name. elsewhere is
// what to do instead when the identity role is not launcher-run: its realm is
// somebody else's, and not this command's to change.
func openAdminRealm(u *UI, flags map[string]string, elsewhere string) (adminRealm, bool) {
	// Each reads the running stack for the config it started with; an
	// unreadable record would quietly substitute this root's sticky
	// preference, and change the realm of a config nothing runs.
	if LoadStackSet().refuseUnreadable(u) {
		return adminRealm{}, false
	}
	var root string
	var ident *kbIdentity
	var err error
	if rootFlag := flags["--root"]; rootFlag != "" {
		root, ident, err = resolveRootArg(rootFlag)
	} else {
		root, _, ident, err = resolveKBRoot()
	}
	if err != nil {
		u.Fail("%v", err)
		if !projectFileRefused(err) {
			fmt.Fprintln(os.Stderr, "  cd into a KB clone, or set SEMIONT_ROOT / pass --root.")
		}
		return adminRealm{}, false
	}
	kb := kbRoot{dir: root, ident: ident}
	if err := os.Chdir(root); err != nil {
		u.Fail("Cannot enter KB root %s: %v", root, err)
		return adminRealm{}, false
	}

	// The RUNNING stack's config, else the sticky one: changing the realm of a
	// config the operator does not actually start with would change the wrong
	// realm — and asking only the sticky preference blocks the ordinary case,
	// since a bare `semiont start` records no preference at all.
	configName := flags["--config"]
	if configName == "" {
		if rec := configForRealm(root); rec != "" {
			configName = rec
			u.Log("Config: %s", u.Dim(configName+" (the running stack's; override with --config)"))
		} else {
			u.Fail("Cannot tell which config this knowledge base runs, and none given — pass --config <name>.")
			return adminRealm{}, false
		}
	}
	st, err := stack.Load(root, configName)
	if err != nil {
		u.Fail("%v", err)
		return adminRealm{}, false
	}
	kcPort, _, _, ok := keycloakPort(u, root)
	if !ok {
		return adminRealm{}, false
	}
	plan, err := derivePlan(st, kcPort)
	if err != nil {
		u.Fail("%v", err)
		return adminRealm{}, false
	}

	rp, ok := plan.Roles["identity"]
	if !ok || rp.Issuer == "" {
		u.Fail("This config declares no identity role, so there is no realm to change.")
		return adminRealm{}, false
	}
	if !mayConfigure(rp) {
		u.Fail("The identity role is not launcher-run, so its realm is not ours to change.")
		fmt.Fprintln(os.Stderr, "  "+elsewhere)
		return adminRealm{}, false
	}

	adminPass, source, ok := keycloakAdminPassword(u, kb.key())
	if !ok {
		return adminRealm{}, false
	}
	if adminPass == "" {
		u.Fail("No Keycloak bootstrap admin password for this root, so the admin API cannot be reached.")
		fmt.Fprintln(os.Stderr, "  It is written on a successful `semiont start`; export KC_BOOTSTRAP_ADMIN_PASSWORD if the realm was created elsewhere.")
		return adminRealm{}, false
	}
	u.Log("Keycloak admin password: %s", u.Dim(source))

	return adminRealm{
		kb:        kb,
		st:        st,
		rp:        rp,
		realm:     keycloakRealm(issuerPath(rp.Issuer)),
		base:      keycloakBase(recordedExposure(kb.key()), rp.Port),
		adminPass: adminPass,
	}, true
}

func identitySync(u *UI, args []string) int {
	flags, positional, ok := subcommandArgs(u, args, "--root", "--config")
	if !ok {
		return 1
	}
	if len(positional) > 0 {
		u.Fail("sync takes no argument: %s", positional[0])
		return 1
	}
	r, ok := openAdminRealm(u, flags, "Create one client per service at your own issuer — see the AUTHENTICATION docs for the claims each needs.")
	if !ok {
		return 1
	}
	// The origins sync writes are the Browser's, at the port its document
	// names: where it runs, or where the next start runs it.
	browser, ok := readBrowserDocument(u, false)
	if !ok {
		return 1
	}
	accounts, ok := realmAccountsOf(&liveExec{u: u}, r.kb)
	if !ok {
		return 1
	}
	u.Log("Reconciling realm %s at %s", u.Bold(r.realm), r.base)

	rep, err := syncRealm(r.base, r.realm, keycloakAdminUser, r.adminPass,
		r.kb.ident.resource(), r.rp.AccessTokenLifespan, browser.spec.Port, accounts)
	if err != nil {
		u.Fail("%v", err)
		return 1
	}

	for _, id := range rep.created {
		u.Log("  created %s", u.Bold(id))
	}
	for _, change := range rep.updated {
		u.Log("  updated %s", u.Bold(change))
	}
	if len(rep.created) == 0 && len(rep.updated) == 0 {
		u.Ok("identity — realm matches this knowledge base (%d clients checked)", len(rep.present))
		return 0
	}
	u.Ok("identity — %d created, %d updated, %d already correct",
		len(rep.created), len(rep.updated), len(rep.present))
	fmt.Fprintln(os.Stderr, "  Run `semiont start` again; the preflight will now find what it was missing.")
	return 0
}

// labelled: the one label grant and revoke name, checked.
func labelled(u *UI, verb string, positional []string) (string, bool) {
	if len(positional) != 1 {
		u.Fail("%s takes one label, the worker's: semiont identity %s <label>", verb, verb)
		return "", false
	}
	if err := checkGrantLabel(positional[0]); err != nil {
		u.Fail("%v", err)
		return "", false
	}
	return positional[0], true
}

func identityGrant(u *UI, args []string) int {
	flags, positional, ok := subcommandArgs(u, args, "--key", "--root", "--config")
	if !ok {
		return 1
	}
	label, ok := labelled(u, "grant", positional)
	if !ok {
		return 1
	}
	keyFile := flags["--key"]
	if keyFile == "" {
		u.Fail("grant needs --key <file>: the public key `semiont worker key` prints on the worker's machine.")
		return 1
	}
	b, err := os.ReadFile(keyFile)
	if err != nil {
		u.Fail("Reading %s: %v", keyFile, err)
		return 1
	}
	k, err := readGrantedKey(b)
	if err != nil {
		u.Fail("%s: %v", keyFile, err)
		return 1
	}
	r, ok := openAdminRealm(u, flags, "Register the worker at your own issuer: a client that authenticates with a signed JWT, holding the key "+keyFile+" holds — see the AUTHENTICATION docs for the claims it needs.")
	if !ok {
		return 1
	}

	rep, err := grantWorker(r.base, r.realm, keycloakAdminUser, r.adminPass, r.kb.ident.resource(), label, k)
	if err != nil {
		u.Fail("%v", err)
		return 1
	}
	switch {
	case len(rep.created) > 0:
		u.Ok("identity — granted %s (key %s)", u.Bold(label), k.thumbprint)
	case len(rep.updated) > 0:
		u.Ok("identity — updated %s", u.Bold(rep.updated[0]))
	default:
		u.Ok("identity — %s is already granted this key (%s)", u.Bold(label), k.thumbprint)
	}
	domain, gateway, clientID := r.kb.ident.domain(), r.st.KnowledgeBase.Spec.Gateway.PublicURL, workerClientID(label)
	fmt.Printf("  Domain:     %s\n", domain)
	fmt.Printf("  Client id:  %s\n", clientID)
	fmt.Printf("  Gateway:    %s\n", gateway)
	fmt.Printf("  On the worker's machine:  semiont worker kb add %s --gateway %s --client-id %s\n", domain, gateway, clientID)
	// Not the issuer: the gateway names the one it trusts in its protected
	// resource metadata, and a second statement of it here could only be wrong.
	fmt.Fprintln(os.Stderr, "  Send these to whoever runs the worker. None is secret; the gateway names the issuer to sign in at.")
	if parsed, err := url.Parse(gateway); err != nil || loopbackHost(parsed.Hostname()) {
		u.Warn("The knowledge base's documents state the gateway at %s, which a worker on another machine cannot reach.", gateway)
	}
	return 0
}

func identityRevoke(u *UI, args []string) int {
	flags, positional, ok := subcommandArgs(u, args, "--root", "--config")
	if !ok {
		return 1
	}
	label, ok := labelled(u, "revoke", positional)
	if !ok {
		return 1
	}
	r, ok := openAdminRealm(u, flags, "Delete the worker's client at your own issuer.")
	if !ok {
		return 1
	}

	revoked, granted, err := revokeWorker(r.base, r.realm, keycloakAdminUser, r.adminPass, label)
	if err != nil {
		u.Fail("%v", err)
		return 1
	}
	if !revoked {
		u.Fail("No worker is granted as %s in realm %s.", label, r.realm)
		if len(granted) > 0 {
			fmt.Fprintf(os.Stderr, "  Granted: %s\n", strings.Join(granted, ", "))
		}
		return 1
	}
	u.Ok("identity — revoked %s (deleted %s)", u.Bold(label), workerClientID(label))
	fmt.Fprintf(os.Stderr, "  A token it already holds stays good until it expires, within %ds.\n", r.rp.AccessTokenLifespan)
	return 0
}
