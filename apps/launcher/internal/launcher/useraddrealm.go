package launcher

// useraddrealm.go — `semiont useradd` against the stack on THIS machine,
// through the launcher's own Keycloak admin client (WHO-RUNS-USERADD P3).
//
// No container. The account lives at the issuer, the launcher already holds
// the bootstrap admin credential for this root, and the realm's admin API is
// reachable the same way `semiont identity sync` reaches it. Nothing about the
// gateway is involved — it need not even be running.

import (
	"fmt"
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
}

// resolveRealmAdmin: this root's launcher-run Keycloak, or a refusal that says
// which precondition failed. The sticky config, exactly as `identity sync`
// resolves it — administering a realm the operator does not actually start
// with would write to the wrong one.
func resolveRealmAdmin(u *ui) (realmAdmin, bool) {
	root, _, err := resolveKBRoot()
	if err != nil {
		u.fail("%v", err)
		fmt.Fprintln(os.Stderr, "  cd into a KB clone, or set SEMIONT_ROOT.")
		return realmAdmin{}, false
	}
	configName := configForRealm(root)
	if configName == "" {
		u.fail("Cannot tell which config this knowledge base runs, so there is no realm to administer.")
		fmt.Fprintln(os.Stderr, "  Start the stack first:  semiont start")
		return realmAdmin{}, false
	}
	configFile := filepath.Join(root, ".semiont", "semiontconfig", configName+".toml")
	envCfg, envName, _, err := loadConfig(configFile)
	if err != nil {
		u.fail("%v", err)
		return realmAdmin{}, false
	}
	plan, err := derivePlan(envCfg, envName, configFile)
	if err != nil {
		u.fail("%v", err)
		return realmAdmin{}, false
	}
	rp, ok := plan.Roles["identity"]
	if !ok || rp.Issuer == "" {
		u.fail("This knowledge base configures no identity provider — add an [identity] section before creating users.")
		return realmAdmin{}, false
	}
	// An issuer Semiont does not administer. The account is created THERE and
	// then signs in here; nothing about this command can reach it.
	if rp.Driver != "keycloak" {
		u.fail("Identity type %q is an issuer Semiont does not administer.", rp.Driver)
		fmt.Fprintf(os.Stderr, "  Create the account at %s, then it can sign in here.\n", rp.Issuer)
		return realmAdmin{}, false
	}
	if rp.Obligation != obligationProvided {
		u.fail("The identity role is not launcher-run, so its accounts are not ours to administer.")
		fmt.Fprintf(os.Stderr, "  Create the account at %s, then it can sign in here.\n", rp.Issuer)
		return realmAdmin{}, false
	}
	adminPass, _ := keycloakAdminPassword(root)
	if adminPass == "" {
		u.fail("No Keycloak bootstrap admin password for this root, so the admin API cannot be reached.")
		fmt.Fprintln(os.Stderr, "  It is written on a successful `semiont start`; export KC_BOOTSTRAP_ADMIN_PASSWORD if the realm was created elsewhere.")
		return realmAdmin{}, false
	}
	base := fmt.Sprintf("http://localhost:%d", rp.Port)
	token, err := adminToken(base, keycloakAdminUser, adminPass)
	if err != nil {
		u.fail("%v", err)
		return realmAdmin{}, false
	}
	return realmAdmin{base: base, realm: keycloakRealm(issuerPath(rp.Issuer)), token: token}, true
}

// useraddLocal: the account decisions, in the order the flags imply. The
// issuer holds whether a person may sign in, so `--active`/`--inactive` are
// written there and nowhere else; absent both, an update leaves that alone.
func useraddLocal(u *ui, o useraddOpts, password string) int {
	a, ok := resolveRealmAdmin(u)
	if !ok {
		return 1
	}
	return applyUseradd(u, a, o, password)
}

// applyUseradd: the decision tree, against an already-resolved realm. Split
// from the resolution so the branching — which the flags drive and an operator
// gets wrong — is testable without a config, a plan or a token exchange.
func applyUseradd(u *ui, a realmAdmin, o useraddOpts, password string) int {
	account, err := findUserByEmail(a.base, a.realm, a.token, o.email)
	if err != nil {
		u.fail("%v", err)
		return 1
	}
	if account != nil && o.upsert {
		fmt.Printf("User already exists: %s\n", o.email)
		return 0
	}
	if account != nil && !o.update {
		u.fail("User %s already exists. Use --update to modify or --upsert to skip silently.", o.email)
		return 1
	}
	if account == nil && o.update {
		u.fail("User %s not found. Remove --update to create a new user.", o.email)
		return 1
	}

	subject := ""
	if account != nil {
		if password != "" {
			if err := setUserPassword(a.base, a.realm, a.token, account.id, password); err != nil {
				u.fail("%v", err)
				return 1
			}
		}
		if o.inactive || o.active {
			if err := setUserEnabled(a.base, a.realm, a.token, account.id, o.active); err != nil {
				u.fail("%v", err)
				return 1
			}
		}
		subject = account.id
	} else {
		if password == "" {
			u.fail("Password required: use --password-stdin or --generate-password")
			return 1
		}
		subject, err = createUser(a.base, a.realm, a.token, o.email, password, !o.inactive)
		if err != nil {
			u.fail("%v", err)
			return 1
		}
	}

	verb := "User created"
	if account != nil {
		verb = "User updated"
	}
	fmt.Printf("%s: %s\n", verb, o.email)
	fmt.Printf("  Subject: %s\n", subject)
	if o.inactive {
		fmt.Println("  Disabled at the identity provider")
	}
	if o.active {
		fmt.Println("  Enabled at the identity provider")
	}
	return 0
}
