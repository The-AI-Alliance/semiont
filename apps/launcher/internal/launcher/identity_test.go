package launcher

// EXTERNAL-IDENTITY P3 (launcher lane): [environments.*.identity] derives the
// identity role. keycloak on ${KEYCLOAK_HOST} is provided — launched with its
// database on the [database] PostgreSQL; an oidc issuer is external —
// verified, never launched; every incomplete section refuses, naming the key.

import (
	"strings"
	"testing"
)

const keycloakIdentity = `[environments.local.identity]
type = "keycloak"
issuer = "http://${KEYCLOAK_HOST}:8080/realms/semiont"
`

// MANDATORY (user, 2026-09-21). Absence used to derive an ABSENT identity
// role, which produced a stack nobody could sign in to: no person, because
// there are no keys to verify against; no sidecar, because the agent-minter
// refuses before it mints; and a gateway that cannot reach its own record,
// because dialling the Archivist needs a service-account token.
func TestDerivePlanRefusesAConfigWithNoIdentity(t *testing.T) {
	p := variantConfig(t, map[string]string{"identity": ""}) // empty drops the section
	env, envName, _, err := loadConfig(p)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if _, err := derivePlan(env, envName, p); err == nil {
		t.Fatal("a config with no identity section was accepted")
	} else if !strings.Contains(err.Error(), "every knowledge base trusts an issuer") {
		t.Errorf("error does not explain why: %v", err)
	}
}

func TestDerivePlanIdentityKeycloakProvided(t *testing.T) {
	plan := mustDerive(t, variantConfig(t, map[string]string{"identity": keycloakIdentity}))
	checkRole(t, plan, "identity", rolePlan{
		Obligation: obligationProvided, Driver: "keycloak",
		Image: "quay.io/keycloak/keycloak:26.7.4", Port: 8080,
		Env: []string{"KC_DB=postgres", "KC_DB_USERNAME=postgres", "KC_DB_PASSWORD=localpass", "KC_BOOTSTRAP_ADMIN_USERNAME=admin"},
	})
	rp := plan.Roles["identity"]
	if rp.Issuer != "http://${KEYCLOAK_HOST}:8080/realms/semiont" {
		t.Errorf("issuer not carried on the plan: %+v", rp)
	}
	if got := identityEndpoint(rp); got != "http://localhost:8080/realms/semiont" {
		t.Errorf("endpoint: got %q", got)
	}
}

func TestDerivePlanIdentityOIDCExternal(t *testing.T) {
	plan := mustDerive(t, variantConfig(t, map[string]string{"identity": `[environments.local.identity]
type = "oidc"
issuer = "https://login.example.com/realms/acme"
`}))
	checkRole(t, plan, "identity", rolePlan{
		Obligation: obligationExternal, Driver: "oidc", Address: "login.example.com", Port: 443,
	})
}

func TestDerivePlanIdentityRefusals(t *testing.T) {
	cases := []struct {
		name, section string
		want          []string
	}{
		{"no type",
			"[environments.local.identity]\nissuer = \"https://login.example.com/realms/acme\"\n",
			[]string{"identity", "\"type\""}},
		{"unknown type",
			"[environments.local.identity]\ntype = \"foo\"\nissuer = \"https://login.example.com\"\n",
			[]string{"unknown type", "foo"}},
		{"oidc without issuer",
			"[environments.local.identity]\ntype = \"oidc\"\n",
			[]string{"identity", "\"issuer\""}},
		{"keycloak issuer without a realm path",
			"[environments.local.identity]\ntype = \"keycloak\"\nissuer = \"http://${KEYCLOAK_HOST}:8080\"\n",
			[]string{"/realms/<realm>"}},
		{"oidc on an injected host",
			"[environments.local.identity]\ntype = \"oidc\"\nissuer = \"http://${KEYCLOAK_HOST}:8080/realms/x\"\n",
			[]string{"launcher-injected host"}},
		{"issuer without a scheme",
			"[environments.local.identity]\ntype = \"oidc\"\nissuer = \"login.example.com\"\n",
			[]string{"http://"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env, envName, _, err := loadConfig(variantConfig(t, map[string]string{"identity": c.section}))
			if err != nil {
				t.Fatalf("loadConfig: %v", err)
			}
			if _, err = derivePlan(env, envName, "variant.toml"); err == nil {
				t.Fatalf("derivePlan accepted %s", c.name)
			}
			for _, w := range c.want {
				if !strings.Contains(err.Error(), w) {
					t.Errorf("error %q missing %q", err, w)
				}
			}
		})
	}
}

func TestDerivePlanKeycloakNeedsDatabase(t *testing.T) {
	env, envName, _, err := loadConfig(variantConfig(t, map[string]string{"identity": keycloakIdentity, "database": ""}))
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if _, err = derivePlan(env, envName, "variant.toml"); err == nil || !strings.Contains(err.Error(), "[database]") {
		t.Fatalf("keycloak without [database] accepted, or the refusal does not name it: %v", err)
	}
}

func TestKeycloakRealmJSONRegistersTheGateway(t *testing.T) {
	doc := string(keycloakRealmJSON("semiont", "https://example.github.io/my-kb", "192.168.64.1", keycloakAccessTokenLifespan, nil))
	// This assertion was the other way round for one commit, on the reasoning
	// that the gateway verifies tokens and never presents one. True of the agent
	// exchange, false in general: the gateway dials the Archivist for content,
	// events and the working tree's branch, and proves who it is like any caller.
	if !strings.Contains(doc, `"clientId": "semiont-gateway"`) {
		t.Error("realm document has no service account for the gateway, which dials the Archivist")
	}
}

func TestKeycloakRealmJSON(t *testing.T) {
	doc := string(keycloakRealmJSON("semiont", "https://example.github.io/my-kb", "192.168.64.1", keycloakAccessTokenLifespan,
		map[string]string{"archivist": "archivist-secret", "weaver": "weaver-secret"}))
	for _, want := range []string{
		`"realm": "semiont"`,
		`"clientId": "semiont-browser"`,
		`"publicClient": true`,
		`"pkce.code.challenge.method": "S256"`,
		// Loopback carries NO port, which is what makes `--port` work: RFC 8252
		// §7.3 has the issuer accept any port on a loopback redirect, and
		// Keycloak honours that only when the registered URI omits it. The LAN
		// address is not loopback, so it stays pinned.
		`"http://localhost/*"`,
		`"http://127.0.0.1/*"`,
		`"http://192.168.64.1:3000/*"`,
		`"included.custom.audience": "https://example.github.io/my-kb"`,
		`"clientId": "semiont-cli"`,
		`"oauth2.device.authorization.grant.enabled": "true"`,
		// The revocation window for every person on this knowledge base: Semiont
		// keeps no admission flag of its own, so a disabled account's token stays
		// good until it expires. A realm imported without this would take whatever
		// Keycloak defaults to that release.
		`"accessTokenLifespan": 300`,
		// Each sidecar that exchanges a service-account token for an agent token
		// needs a confidential client of its own. A shared one would be the
		// static secret this replaced, wearing a realm's clothes.
		`"clientId": "semiont-archivist"`,
		`"clientId": "semiont-weaver"`,
		`"serviceAccountsEnabled": true`,
		`"secret": "archivist-secret"`,
		// The gateway reads a FLAT roles array; Keycloak's nested realm_access
		// shape is deliberately not what this stamps.
		`"claim.name": "roles"`,
		`"claim.value": "[\"semiont-service\"]"`,
		// The realm declares its own user profile rather than inheriting
		// Keycloak's. firstName and lastName are required, so a person an
		// administrator created an account for names themselves at first
		// sign-in — and the `name` claim every event carries is one they chose.
		// Inherited, this moves with a Keycloak upgrade and has no line to read.
		`"declarative-user-profile"`,
		`\"name\":\"firstName\"`,
		`\"name\":\"lastName\"`,
		`\"required\":{\"roles\":[\"user\"]}`,
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("realm document missing %s", want)
		}
	}
}

// accessTokenLifespan overrides the default revocation window. Only the
// launcher reads it, because only a realm the launcher writes has a lifespan
// Semiont sets.
func TestDerivePlanIdentityAccessTokenLifespan(t *testing.T) {
	plan := mustDerive(t, variantConfig(t, map[string]string{"identity": `[environments.local.identity]
type = "keycloak"
issuer = "http://${KEYCLOAK_HOST}:8080/realms/semiont"
accessTokenLifespan = 60
`}))
	if got := plan.Roles["identity"].AccessTokenLifespan; got != 60 {
		t.Errorf("configured lifespan not carried on the plan: got %d, want 60", got)
	}
	doc := string(keycloakRealmJSON("semiont", "aud", "1.2.3.4", plan.Roles["identity"].AccessTokenLifespan, nil))
	if !strings.Contains(doc, `"accessTokenLifespan": 60`) {
		t.Error("the realm document did not take the configured lifespan")
	}
}

// Absent means the pinned default, and the realm says so explicitly rather
// than omitting the key and taking whatever Keycloak defaults to.
func TestDerivePlanIdentityLifespanDefaults(t *testing.T) {
	plan := mustDerive(t, variantConfig(t, map[string]string{"identity": keycloakIdentity}))
	if got := plan.Roles["identity"].AccessTokenLifespan; got != keycloakAccessTokenLifespan {
		t.Errorf("absent lifespan did not fall to the default: got %d", got)
	}
}

// Refused, not ignored, on both counts: an issuer somebody else runs sets its
// own lifetimes, and a nonsense value silently accepted would leave an operator
// believing they had shortened their window.
func TestDerivePlanIdentityLifespanRefusals(t *testing.T) {
	for _, c := range []struct{ name, section, want string }{
		{"oidc", `[environments.local.identity]
type = "oidc"
issuer = "https://login.example.com/realms/acme"
accessTokenLifespan = 60
`, "applies only to type"},
		{"zero", `[environments.local.identity]
type = "keycloak"
issuer = "http://${KEYCLOAK_HOST}:8080/realms/semiont"
accessTokenLifespan = 0
`, "positive number of seconds"},
		{"negative", `[environments.local.identity]
type = "keycloak"
issuer = "http://${KEYCLOAK_HOST}:8080/realms/semiont"
accessTokenLifespan = -5
`, "positive number of seconds"},
	} {
		t.Run(c.name, func(t *testing.T) {
			env, envName, _, err := loadConfig(variantConfig(t, map[string]string{"identity": c.section}))
			if err != nil {
				t.Fatalf("loadConfig: %v", err)
			}
			if _, err = derivePlan(env, envName, "variant.toml"); err == nil {
				t.Fatalf("accepted %s", c.name)
			} else if !strings.Contains(err.Error(), c.want) {
				t.Errorf("error %q missing %q", err, c.want)
			}
		})
	}
}
