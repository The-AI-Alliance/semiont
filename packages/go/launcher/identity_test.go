package launcher

// The identity role: the issuer the knowledge base trusts. An Issuer document
// is a Keycloak the launcher runs, with its realm on the PostgreSQL that
// document names; spec.issuer.external is an issuer somebody else runs —
// verified, never launched. What the schemas cannot state is refused by the
// plan, naming the document and the field.

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// trustExternalIssuer: st trusting an issuer somebody else runs, with no
// Issuer document — and so no PostgreSQL of the launcher's for it.
func trustExternalIssuer(st *stack.Stack, typ, url string) {
	st.KnowledgeBase.Spec.Issuer.Ref = nil
	st.KnowledgeBase.Spec.Issuer.External = &stack.KnowledgeBaseIssuerExternal{Type: typ, Url: url}
	st.Issuer = nil
}

func TestDerivePlanIdentityKeycloakProvided(t *testing.T) {
	plan := mustPlan(t, fixtureStack(t, "anthropic"))
	checkRole(t, plan, "identity", rolePlan{
		Presence: presenceLauncher, Driver: "keycloak",
		Image: "quay.io/keycloak/keycloak:26.7.4@sha256:82a77884f3af238beab1e7afd63b5f530e1b5c0590bd7aa60b40a40463e29b2c", Memory: "1G", Port: 8080,
		Env: []string{"KC_DB=postgres", "KC_DB_USERNAME=postgres", "KC_BOOTSTRAP_ADMIN_USERNAME=admin"},
	})
	rp := plan.Roles["identity"]
	if rp.Issuer != "http://localhost:8080/realms/semiont" {
		t.Errorf("issuer not carried on the plan: %+v", rp)
	}
	if got := identityEndpoint(rp, exposure{}); got != "http://localhost:8080/realms/semiont" {
		t.Errorf("endpoint: got %q", got)
	}
}

// An issuer somebody else runs is verified at the address its URL names, and
// the PostgreSQL a Keycloak of the launcher's would keep its realm on is not
// part of the stack.
func TestDerivePlanIdentityOIDCExternal(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	trustExternalIssuer(st, "oidc", "https://login.example.com/realms/acme")
	plan := mustPlan(t, st)
	checkRole(t, plan, "identity", rolePlan{
		Presence: presenceExternal, Driver: "oidc", Address: "login.example.com", Port: 443,
	})
	if got := plan.Roles["identity"].Issuer; got != "https://login.example.com/realms/acme" {
		t.Errorf("issuer %q, want the URL the KnowledgeBase states", got)
	}
	if got := plan.Roles["database"].Presence; got != presenceAbsent {
		t.Errorf("with no Issuer document the database is %s, want absent", got)
	}
}

func TestDerivePlanIdentityRefusals(t *testing.T) {
	cases := []struct {
		name  string
		state func(st *stack.Stack)
		file  func(st *stack.Stack) string
		want  []string
	}{
		{"an external issuer of an unknown type",
			func(st *stack.Stack) { trustExternalIssuer(st, "foo", "https://login.example.com/realms/acme") },
			func(st *stack.Stack) string { return st.Files.KnowledgeBase },
			[]string{"spec.issuer.external.type", `"foo"`, `"keycloak"`, `"oidc"`}},
		{"an external issuer without a scheme",
			func(st *stack.Stack) { trustExternalIssuer(st, "oidc", "login.example.com") },
			func(st *stack.Stack) string { return st.Files.KnowledgeBase },
			[]string{"spec.issuer.external.url", `"login.example.com"`, "http://"}},
		{"an Issuer document of a type the launcher does not run",
			func(st *stack.Stack) { st.Issuer.Spec.Type = "authentik" },
			func(st *stack.Stack) string { return st.Files.Issuer },
			[]string{"spec.type", `"authentik"`, `"keycloak"`}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			st := fixtureStack(t, "anthropic")
			file := c.file(st)
			c.state(st)
			mustRefuse(t, st, append([]string{file + ": "}, c.want...)...)
		})
	}
}

func TestKeycloakRealmJSONRegistersTheGateway(t *testing.T) {
	doc := string(keycloakRealmJSON("semiont", "https://example.github.io/my-kb", 3000, keycloakAccessTokenLifespan, realmAccounts{}))
	// The gateway verifies tokens, and in the agent exchange never presents
	// one — but it dials the Archivist for content, events and the working
	// tree's branch, and proves who it is like any caller.
	if !strings.Contains(doc, `"clientId": "semiont-gateway"`) {
		t.Error("realm document has no service account for the gateway, which dials the Archivist")
	}
}

func TestKeycloakRealmJSON(t *testing.T) {
	doc := string(keycloakRealmJSON("semiont", "https://example.github.io/my-kb", 3000, keycloakAccessTokenLifespan,
		realmAccounts{secrets: map[string]string{"archivist": "archivist-secret", "weaver": "weaver-secret"}}))
	for _, want := range []string{
		`"realm": "semiont"`,
		`"clientId": "semiont-browser"`,
		`"publicClient": true`,
		`"pkce.code.challenge.method": "S256"`,
		// Loopback carries NO port, which lets the Browser's document name
		// any port: RFC 8252 §7.3 has the issuer accept any port on a
		// loopback redirect, and Keycloak honours that only when the
		// registered URI omits it.
		`"http://localhost/*"`,
		`"http://127.0.0.1/*"`,
		`"included.custom.audience": "https://example.github.io/my-kb"`,
		`"clientId": "semiont-cli"`,
		`"oauth2.device.authorization.grant.enabled": "true"`,
		// The revocation window for every person on this knowledge base: Semiont
		// keeps no admission flag of its own, so a disabled account's token stays
		// good until it expires. A realm imported without this would take whatever
		// Keycloak defaults to that release.
		`"accessTokenLifespan": 300`,
		// Each service signs in as its own account, so each needs a
		// confidential client of its own. A shared one would be a static
		// secret wearing a realm's clothes.
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

// Every agent account's client stamps the kind claim, and no person's does:
// the public clients people sign in through carry no such mapper, so a
// person's token never says it is an agent's.
func TestTheRealmMarksEveryAgentsAccountAndNoPersons(t *testing.T) {
	var doc struct {
		Clients []map[string]any `json:"clients"`
	}
	if err := json.Unmarshal(keycloakRealmJSON("semiont", "aud", 3000, keycloakAccessTokenLifespan, realmAccounts{worker: testWorkerKey()}), &doc); err != nil {
		t.Fatal(err)
	}
	stamps := func(client map[string]any) bool {
		mappers, _ := client["protocolMappers"].([]any)
		for _, m := range mappers {
			cfg, _ := m.(map[string]any)["config"].(map[string]any)
			if cfg["claim.name"] == kindClaim {
				return cfg["claim.value"] == agentKind && cfg["jsonType.label"] == "String"
			}
		}
		return false
	}
	accounts := 0
	for _, c := range doc.Clients {
		switch c["clientId"] {
		case semiont.BrowserClientID, semiont.ScriptClientID:
			if stamps(c) {
				t.Errorf("%v, a client people sign in through, stamps the agent kind", c["clientId"])
			}
		default:
			accounts++
			if !stamps(c) {
				t.Errorf("%v, an agent's account, does not stamp %s %q", c["clientId"], kindClaim, agentKind)
			}
		}
	}
	if accounts != len(stackServices) {
		t.Errorf("%d agent accounts in the realm, want one per stack service (%d)", accounts, len(stackServices))
	}
}

// accessTokenLifespan sets the revocation window of the realm the launcher
// imports. Only the launcher reads it, because only a realm the launcher
// writes has a lifespan Semiont sets.
func TestDerivePlanIdentityAccessTokenLifespan(t *testing.T) {
	st := fixtureStack(t, "anthropic")
	st.Issuer.Spec.AccessTokenLifespan = 60
	plan := mustPlan(t, st)
	if got := plan.Roles["identity"].AccessTokenLifespan; got != 60 {
		t.Errorf("configured lifespan not carried on the plan: got %d, want 60", got)
	}
	doc := string(keycloakRealmJSON("semiont", "aud", 3000, plan.Roles["identity"].AccessTokenLifespan, realmAccounts{}))
	if !strings.Contains(doc, `"accessTokenLifespan": 60`) {
		t.Error("the realm document did not take the configured lifespan")
	}
}

// The browser client's web origins name the Browser's port. Keycloak derives a
// client's CORS origins from `webOrigins`, and matches them EXACTLY — unlike
// redirect URIs, where RFC 8252 §7.3 makes a portless loopback entry match any
// port. `"+"` means "derive them from the redirect URIs", so the portless
// entries that let the Browser's document name any port would yield
// `http://localhost` (port 80) and leave the Browser's real origin,
// `http://localhost:3000`, in no set at all.
// The token POST is cross-origin, so Keycloak would answer 403 `Invalid origin`
// with no CORS header and sign-in would die as an opaque `error=Verification`.
func TestBrowserWebOriginsCarryThePort(t *testing.T) {
	origins := loopbackWebOrigins(3000)
	for _, want := range []string{
		"http://localhost:3000",
		"http://127.0.0.1:3000",
	} {
		if !slices.Contains(origins, want) {
			t.Errorf("web origins %v missing %s", origins, want)
		}
	}
	// `+` is the defect: it couples origins to the redirect URIs, which are
	// deliberately portless.
	if slices.Contains(origins, "+") {
		t.Error(`web origins still delegate to the redirect URIs with "+"`)
	}
}

// The Browser's document moves the Browser, so the origin moves with it.
func TestBrowserWebOriginsFollowTheBrowserPort(t *testing.T) {
	origins := loopbackWebOrigins(3001)
	if !slices.Contains(origins, "http://localhost:3001") {
		t.Errorf("web origins %v do not follow the Browser port", origins)
	}
	if slices.Contains(origins, "http://localhost:3000") {
		t.Errorf("web origins %v kept the default port after a move", origins)
	}
}

// The realm document is what actually reaches Keycloak, so the origin has to
// survive the render — and the redirect URIs must stay portless beside it.
func TestKeycloakRealmJSONAllowsTheBrowsersOrigin(t *testing.T) {
	doc := string(keycloakRealmJSON("semiont", "https://example.github.io/my-kb", 3000, keycloakAccessTokenLifespan, realmAccounts{}))
	for _, want := range []string{
		`"http://localhost:3000"`,
		`"http://127.0.0.1:3000"`,
		// The redirect leg keeps RFC 8252's portless loopback.
		`"http://localhost/*"`,
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("realm document missing %s", want)
		}
	}
	if strings.Contains(doc, `"webOrigins": [`+"\n"+`      "+"`) || strings.Contains(doc, `"webOrigins": ["+"]`) {
		t.Error(`realm document still carries webOrigins "+"`)
	}
}
