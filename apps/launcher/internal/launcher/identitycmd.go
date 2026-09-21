package launcher

// identitycmd.go — `semiont identity sync`, the operator-facing half of
// identitysync.go.
//
// Resolution mirrors `start`'s exactly, and deliberately: sync must reconcile
// the realm THIS root would import, against the credentials THIS root would
// inject. Deriving either differently is how a repair produces a realm that
// still does not match the next start.

import (
	"fmt"
	"os"
	"path/filepath"
)

const identityUsage = `Usage: semiont identity sync [--root <path>] [--config <name>]

Reconcile a running realm against what this knowledge base needs: the
service-account clients, the loopback redirect URIs that let the Browser move
port, the implicit flow (off), and the access-token lifetime.

A realm is imported on its FIRST boot and never again, so a deployment that
predates a service simply does not have that service's client — and
` + "`semiont start`" + ` refuses, correctly, rather than starting six processes
that cannot authenticate. This adds what is missing.

It reconciles CONFIGURATION ONLY. It creates clients and changes nothing else:
no accounts are read, written or deleted, so it is safe to run against a realm
with real users. It is idempotent — run it again to confirm it worked.

Needs Keycloak's bootstrap admin password, the same one ` + "`semiont start`" + `
reports: $KC_BOOTSTRAP_ADMIN_PASSWORD, else the value persisted for this root.
It will not generate one — a fresh password cannot open the realm an existing
database already holds.
`

func Identity(args []string) int {
	u := newUI(false)
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Print(identityUsage)
		if len(args) == 0 {
			return 1
		}
		return 0
	}
	if args[0] != "sync" {
		u.fail("Unknown identity subcommand: %s", args[0])
		fmt.Fprint(os.Stderr, identityUsage)
		return 1
	}

	rootFlag, configName := "", ""
	rest := args[1:]
	for i := 0; i < len(rest); i++ {
		switch rest[i] {
		case "--root", "--config":
			if i+1 >= len(rest) {
				u.fail("Missing value for %s", rest[i])
				return 1
			}
			if rest[i] == "--root" {
				rootFlag = rest[i+1]
			} else {
				configName = rest[i+1]
			}
			i++
		default:
			u.fail("Unknown flag: %s", rest[i])
			return 1
		}
	}

	var root string
	var err error
	if rootFlag != "" {
		root, err = resolveRootArg(rootFlag)
	} else {
		root, _, err = resolveKBRoot()
	}
	if err != nil {
		u.fail("%v", err)
		fmt.Fprintln(os.Stderr, "  cd into a KB clone, or set SEMIONT_ROOT / pass --root.")
		return 1
	}
	if err := os.Chdir(root); err != nil {
		u.fail("Cannot enter KB root %s: %v", root, err)
		return 1
	}

	// The sticky config, exactly as start resolves it: reconciling against a
	// config the operator does not actually start with would repair the wrong
	// realm.
	if configName == "" {
		if rec := recordedConfig(root); rec != "" {
			configName = rec
			u.log("Config: %s", u.dim(configName+" (recorded from last start; override with --config)"))
		} else {
			u.fail("No config recorded for this root, and none given — pass --config <name>.")
			return 1
		}
	}
	configFile := filepath.Join(configDir, configName+".toml")
	envCfg, envName, _, err := loadConfig(configFile)
	if err != nil {
		u.fail("%v", err)
		return 1
	}
	plan, err := derivePlan(envCfg, envName, configFile)
	if err != nil {
		u.fail("%v", err)
		return 1
	}

	rp, ok := plan.Roles["identity"]
	if !ok || rp.Issuer == "" {
		u.fail("This config declares no identity role, so there is no realm to reconcile.")
		return 1
	}
	if rp.Obligation != obligationProvided {
		u.fail("The identity role is not launcher-run, so its realm is not ours to reconcile.")
		fmt.Fprintln(os.Stderr, "  Create one client per service at your own issuer — see the AUTHENTICATION docs for the claims each needs.")
		return 1
	}

	adminPass, source := keycloakAdminPassword(root)
	if adminPass == "" {
		u.fail("No Keycloak bootstrap admin password for this root, so the admin API cannot be reached.")
		fmt.Fprintln(os.Stderr, "  It is written on a successful `semiont start`; export KC_BOOTSTRAP_ADMIN_PASSWORD if the realm was created elsewhere.")
		return 1
	}
	u.log("Keycloak admin password: %s", u.dim(source))

	secrets := map[string]string{}
	for _, svc := range serviceClients {
		secret, ok := loadOrCreateServiceClientSecret(u, root, svc)
		if !ok {
			return 1
		}
		secrets[svc] = secret
	}

	realm := keycloakRealm(issuerPath(rp.Issuer))
	base := fmt.Sprintf("http://localhost:%d", rp.Port)
	u.log("Reconciling realm %s at %s", u.bold(realm), base)

	rep, err := syncRealm(base, realm, keycloakAdminUser, adminPass,
		committedResource(root), rp.AccessTokenLifespan,
		func(svc string) string { return secrets[svc] })
	if err != nil {
		u.fail("%v", err)
		return 1
	}

	for _, id := range rep.created {
		u.log("  created %s", u.bold(id))
	}
	for _, change := range rep.updated {
		u.log("  updated %s", u.bold(change))
	}
	if len(rep.created) == 0 && len(rep.updated) == 0 {
		u.ok("identity — realm matches this knowledge base (%d clients checked)", len(rep.present))
		return 0
	}
	u.ok("identity — %d created, %d updated, %d already correct",
		len(rep.created), len(rep.updated), len(rep.present))
	fmt.Fprintln(os.Stderr, "  Run `semiont start` again; the preflight will now find what it was missing.")
	return 0
}
