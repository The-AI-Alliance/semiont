package launcher

// useraddrealm.go — `semiont useradd` against the stack on THIS machine,
// through the launcher's own Keycloak admin client.
//
// No container. The account lives at the issuer, the launcher already holds
// the bootstrap admin credential for this root, and the realm's admin API is
// reachable the same way `semiont identity sync` reaches it. Nothing about the
// gateway is involved — it need not even be running.

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
)

// useraddOpts: what the flags mean once parsed. The launcher owns them now
// rather than forwarding them to a second parser.
type useraddOpts struct {
	email    string
	generate bool
	update   bool
	upsert   bool
	active   bool
	inactive bool
	stdin    bool
}

// realmAdmin: everything one admin call needs, resolved once.
type realmAdmin struct {
	base  string
	realm string
	token string
	// domain and subjectClaim name the identity an account acts under:
	// did:web:<domain>:users:<the value of the claim subjectClaim names>.
	domain       string
	subjectClaim string
}

// resolveRealmAdmin: this root's launcher-run Keycloak, or a refusal that says
// which precondition failed. The sticky config, exactly as `identity sync`
// resolves it — administering a realm the operator does not actually start
// with would write to the wrong one.
func resolveRealmAdmin(u *UI, root string) (realmAdmin, bool) {
	// The identity an account acts under is named under the knowledge base's
	// committed domain; without one, the gateway has no identity to run under
	// either.
	domain := committedDomain(root)
	if domain == "" {
		u.Fail("The knowledge base at %s declares no [site] domain in its .semiont/config, so no account can be named under it.", root)
		return realmAdmin{}, false
	}
	configName := configForRealm(root)
	if configName == "" {
		u.Fail("Cannot tell which config this knowledge base runs, so there is no realm to administer.")
		fmt.Fprintln(os.Stderr, "  Start the stack first:  semiont start")
		return realmAdmin{}, false
	}
	configFile := filepath.Join(root, ".semiont", "semiontconfig", configName+".toml")
	envCfg, envName, _, err := loadConfig(configFile)
	if err != nil {
		u.Fail("%v", err)
		return realmAdmin{}, false
	}
	kcPort, _, _, ok := keycloakPort(u, root)
	if !ok {
		return realmAdmin{}, false
	}
	plan, err := derivePlan(envCfg, envName, configFile, kcPort)
	if err != nil {
		u.Fail("%v", err)
		return realmAdmin{}, false
	}
	rp, ok := plan.Roles["identity"]
	if !ok || rp.Issuer == "" {
		u.Fail("This knowledge base configures no identity provider — add an [identity] section before creating users.")
		return realmAdmin{}, false
	}
	// An issuer Semiont does not administer. The account is created THERE and
	// then signs in here; nothing about this command can reach it.
	if rp.Driver != "keycloak" {
		u.Fail("Identity type %q is an issuer Semiont does not administer.", rp.Driver)
		fmt.Fprintf(os.Stderr, "  Create the account at %s, then it can sign in here.\n", rp.Issuer)
		return realmAdmin{}, false
	}
	if !mayConfigure(rp) {
		u.Fail("The identity role is not launcher-run, so its accounts are not ours to administer.")
		fmt.Fprintf(os.Stderr, "  Create the account at %s, then it can sign in here.\n", rp.Issuer)
		return realmAdmin{}, false
	}
	adminPass, _, ok := keycloakAdminPassword(u, root)
	if !ok {
		return realmAdmin{}, false
	}
	if adminPass == "" {
		u.Fail("No Keycloak bootstrap admin password for this root, so the admin API cannot be reached.")
		fmt.Fprintln(os.Stderr, "  It is written on a successful `semiont start`; export KC_BOOTSTRAP_ADMIN_PASSWORD if the realm was created elsewhere.")
		return realmAdmin{}, false
	}
	base := fmt.Sprintf("http://localhost:%d", rp.Port)
	token, err := adminToken(base, keycloakAdminUser, adminPass)
	if err != nil {
		u.Fail("%v", err)
		return realmAdmin{}, false
	}
	return realmAdmin{
		base: base, realm: keycloakRealm(issuerPath(rp.Issuer)), token: token,
		domain: domain, subjectClaim: envCfg.Identity.SubjectClaim,
	}, true
}

// useraddLocal: the account decisions, in the order the flags imply. The
// issuer holds whether a person may sign in, so `--active`/`--inactive` are
// written there and nowhere else; absent both, an update leaves that alone.
func useraddLocal(u *UI, o useraddOpts, password, root string) (code int, created bool) {
	a, ok := resolveRealmAdmin(u, root)
	if !ok {
		return 1, false
	}
	return applyUseradd(u, a, o, password)
}

// applyUseradd: the decision tree, against an already-resolved realm. Split
// from the resolution so the branching — which the flags drive and an operator
// gets wrong — is testable without a config, a plan or a token exchange.
func applyUseradd(u *UI, a realmAdmin, o useraddOpts, password string) (code int, created bool) {
	account, err := findUserByEmail(a.base, a.realm, a.token, o.email)
	if err != nil {
		u.Fail("%v", err)
		return 1, false
	}
	if account != nil && o.upsert {
		fmt.Printf("User already exists: %s\n", o.email)
		return 0, false
	}
	if account != nil && !o.update {
		u.Fail("User %s already exists. Use --update to modify or --upsert to skip silently.", o.email)
		return 1, false
	}
	if account == nil && o.update {
		u.Fail("User %s not found. Remove --update to create a new user.", o.email)
		return 1, false
	}
	// --generate-password: made HERE, by the launcher that writes it to the
	// realm — after every refusal, so a rejected call invents nothing. On the
	// codespace path the flag is forwarded and the codespace's own launcher
	// arrives here, so the password is born where it is used and never crosses
	// the ssh hop as an argument.
	if o.generate {
		if password, err = generatePassword(); err != nil {
			u.Fail("Cannot generate a password: %v", err)
			return 1, false
		}
	}

	subject := ""
	if account != nil {
		if password != "" {
			if err := setUserPassword(a.base, a.realm, a.token, account.id, password); err != nil {
				u.Fail("%v", err)
				return 1, false
			}
		}
		if o.inactive || o.active {
			if err := setUserEnabled(a.base, a.realm, a.token, account.id, o.active); err != nil {
				u.Fail("%v", err)
				return 1, false
			}
		}
		subject = account.id
	} else {
		if password == "" {
			u.Fail("Password required: use --password-stdin or --generate-password")
			return 1, false
		}
		subject, err = createUser(a.base, a.realm, a.token, o.email, password, !o.inactive)
		if err != nil {
			u.Fail("%v", err)
			return 1, false
		}
	}

	verb := "User created"
	if account != nil {
		verb = "User updated"
	}
	fmt.Printf("%s: %s\n", verb, o.email)
	if o.generate {
		fmt.Printf("  Password: %s  %s\n", password, u.Dim("(generated — shown this once, stored nowhere)"))
	}
	fmt.Printf("  Identity: %s\n", accountIdentity(a, o.email, subject))
	if o.inactive {
		fmt.Println("  Disabled at the identity provider")
	}
	if o.active {
		fmt.Println("  Enabled at the identity provider")
	}
	return 0, account == nil
}

// generatePassword: 16 characters from crypto/rand over [A-Za-z0-9] — about 95
// bits, typeable, and free of shell metacharacters so it survives a paste.
func generatePassword() (string, error) {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	out := make([]byte, 16)
	for i := range out {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			return "", err
		}
		out[i] = alphabet[n.Int64()]
	}
	return string(out), nil
}

// accountIdentity: the DID the account acts under, by the gateway's rule —
// did:web:<domain>:users:<the value of the claim [identity] subjectClaim
// names>. The launcher knows that value for the claims it sets itself: the
// account id (sub), and the email, which is also the username. Any other claim
// is the issuer's to fill at sign-in.
func accountIdentity(a realmAdmin, email, subject string) string {
	switch a.subjectClaim {
	case "sub":
		return personDID(a.domain, subject)
	case "email", "preferred_username":
		return personDID(a.domain, email)
	}
	return fmt.Sprintf("under %s, named by the issuer's %q claim at sign-in", a.domain, a.subjectClaim)
}

// useraddNextSteps: what the person does with an account just created — sign
// in, at the Browser this machine serves, or from a terminal against the stack
// the command selected, named the way it was selected.
func useraddNextSteps(codespace, local *StackState) []string {
	login := "semiont login"
	if codespace != nil {
		login += " --repo " + codespace.Codespace.Repo
	} else {
		login += " --runtime " + local.Runtime
	}
	return []string{
		fmt.Sprintf("Next: sign in at http://localhost:%d with this email and password.", defaultBrowserPort),
		"  Keycloak asks for a first and last name on the first sign-in.",
		"  From a terminal: " + login,
	}
}
