package launcher

// identity.go — the launched Keycloak's shape beyond its plan row: the issuer
// URL's parts, the realm it imports, and the run-time extras (realm file,
// database, admin password) a `run -d` needs that derivePlan cannot know.

import (
	"encoding/json"
	"fmt"
	"strings"
)

const (
	keycloakAdminUser = "admin"
	keycloakDatabase  = "keycloak"
	// browserClientID: the Browser's registration in every KB realm. The
	// Browser is machine-level, so one public client (PKCE) serves it.
	browserClientID = "semiont-browser"

	// serviceRole: what a token must carry, in a FLAT `roles` array, for the
	// gateway to mint a software-agent token for its bearer. Flat and
	// vendor-neutral by design — the gateway's verification path names no
	// Keycloak structure, so an operator federating another issuer maps their
	// own groups into the same claim. Must equal SERVICE_ROLE in
	// apps/gateway/src/identity/agent-minter.ts.
	serviceRole = "semiont-service"

	// workerRole: the realm role marking a client permitted to CLAIM JOBS
	// (EXTRACT-JOBS P0). Granted only to the worker client here; a deployment
	// running FOREIGN workers grants it to their clients the same way, and the
	// dispatcher's authorization is unchanged. Distinct from serviceRole, which
	// every service client carries: service-ness is the floor, worker-ness the
	// finer grant. Authorizing a job:claim by this ROLE — not by matching the
	// worker's client id — is what lets a foreign worker claim. Must equal
	// WORKER_ROLE in packages/core/src/service-role.ts (held by lint:service-role).
	workerRole = "semiont-worker"

	// keycloakAccessTokenLifespan: how long an access token the realm mints
	// stays valid, in seconds.
	//
	// This is the revocation window for every person using the knowledge base.
	// Semiont holds no per-user admission flag: disabling an account here stops
	// the realm minting and stops it refreshing, but a token already in someone's
	// hand keeps working until it expires. That expiry is this number.
	//
	// Pinned rather than left to Keycloak's default so the window is a decision
	// somebody made and can read back, not a value that moves with a Keycloak
	// upgrade. A knowledge base that wants a different one sets
	// `accessTokenLifespan` in its [identity] section; this is what it gets
	// otherwise.
	keycloakAccessTokenLifespan = 300
)

// splitIssuer: the host, port and path of an issuer URL. Not url.Parse — a
// launcher-injected ${KEYCLOAK_HOST} is not a legal hostname to it.
func splitIssuer(issuer string) (host string, port int, path string, err error) {
	rest, ok := strings.CutPrefix(issuer, "http://")
	if !ok {
		if rest, ok = strings.CutPrefix(issuer, "https://"); !ok {
			return "", 0, "", fmt.Errorf("must start with http:// or https://")
		}
	}
	authority, p, _ := strings.Cut(rest, "/")
	host, port = parseHostPort(authority)
	if host == "" {
		return "", 0, "", fmt.Errorf("names no host")
	}
	return host, port, "/" + p, nil
}

func issuerPath(issuer string) string {
	_, _, path, err := splitIssuer(issuer)
	if err != nil {
		return "/"
	}
	return path
}

// keycloakRealm: the realm named by an issuer path of the shape
// /realms/<realm>; "" for any other path.
func keycloakRealm(path string) string {
	realm, ok := strings.CutPrefix(path, "/realms/")
	if !ok || realm == "" || strings.Contains(realm, "/") {
		return ""
	}
	return realm
}

// identityEndpoint: the issuer as reachable from this host — the realm's
// root, which Keycloak serves only once the realm exists.
func identityEndpoint(rp rolePlan) string {
	return fmt.Sprintf("http://localhost:%d%s", rp.Port, issuerPath(rp.Issuer))
}

// serviceClients: every process that PRESENTS a token to another Semiont
// service, and so needs an account at the realm.
//
// The gateway is among them, which it was not at first. The argument for
// leaving it out — "it verifies tokens, it never presents one" — was true of
// the agent exchange and false in general: the gateway dials the Archivist for
// content, events and the working tree's branch, and has to prove who it is
// like anyone else.
var serviceClients = []string{"archivist", "dispatcher", "gateway", "librarian", "smelter", "weaver", "worker"}

// serviceClientID: the realm client id for one service's account.
func serviceClientID(svc string) string { return "semiont-" + svc }

// serviceRolesClaim renders the JSON `roles` array a service client's token
// carries. Every service client gets serviceRole; the worker ALSO gets
// workerRole (EXTRACT-JOBS P0), so a token it presents to /api/tokens/agent is
// minted an agent token stamped with the worker capability, and the dispatcher
// admits that agent's job:claim. A deployment running foreign workers grants
// workerRole to their clients the same way.
func serviceRolesClaim(svc string) string {
	roles := []string{serviceRole}
	if svc == "worker" {
		roles = append(roles, workerRole)
	}
	b, _ := json.Marshal(roles)
	return string(b)
}

// serviceAccountClient: a confidential client that can obtain a token for
// ITSELF (the client-credentials grant) and nothing else — no browser flow, no
// password grant, no user behind it.
//
// Two mappers ride on it. The audience mapper is the same one the public
// clients carry, so the gateway's audience check passes. The roles mapper
// hardcodes the agent role: an operator creating this client IS the assertion
// that this process may mint agent identities, and a hardcoded claim says that
// without needing a realm role created and assigned in the same import.
func serviceAccountClient(svc, secret, audience string) map[string]any {
	return map[string]any{
		"clientId":                  serviceClientID(svc),
		"name":                      "Semiont " + svc,
		"enabled":                   true,
		"protocol":                  "openid-connect",
		"publicClient":              false,
		"secret":                    secret,
		"serviceAccountsEnabled":    true,
		"standardFlowEnabled":       false,
		"implicitFlowEnabled":       false,
		"directAccessGrantsEnabled": false,
		"protocolMappers": []map[string]any{
			{
				"name":            "gateway audience",
				"protocol":        "openid-connect",
				"protocolMapper":  "oidc-audience-mapper",
				"consentRequired": false,
				"config": map[string]string{
					"included.custom.audience": audience,
					"access.token.claim":       "true",
					"id.token.claim":           "false",
				},
			},
			{
				"name":            "semiont service role",
				"protocol":        "openid-connect",
				"protocolMapper":  "oidc-hardcoded-claim-mapper",
				"consentRequired": false,
				"config": map[string]string{
					"claim.name":         "roles",
					"claim.value":        serviceRolesClaim(svc),
					"jsonType.label":     "JSON",
					"access.token.claim": "true",
					"id.token.claim":     "false",
				},
			},
		},
	}
}

// keycloakRealmJSON renders the realm Keycloak imports on FIRST BOOT: the
// realm itself, two public clients — the Browser's (authorization code
// with PKCE) and the launcher's (the device grant) — each with an audience
// mapper that stamps the gateway's client id into every access token, the
// value the gateway's verifier checks.
//
// Import SKIPS a realm that already exists, so a second start changes nothing —
// including the values here. A deployment whose realm predates a change to this
// function keeps the settings it was created with; adjusting those is a console
// or admin-API job, not a restart.
// browserClient / cliClient: the two PUBLIC registrations, rendered once so
// the realm import and `semiont identity sync` cannot disagree about them.
// They were inline in keycloakRealmJSON until sync needed to reconcile the
// same fields; a second copy there would have been a mirror of the realm
// document, and the loopback rule below is exactly the kind of detail a
// second copy loses.
// natsConfPath: where the staged broker config is mounted. Fixed, so the plan
// can name it without knowing where the launcher staged the file.
const natsConfPath = "/etc/nats/semiont.conf"

// natsConf: the broker's authorization block.
//
// It carries NO credential — only the two variable NAMES, which nats-server
// interpolates from its own environment. That is what lets the values travel
// the way every other service credential here does (the graph role hands neo4j
// NEO4J_AUTH, the database role hands postgres POSTGRES_PASSWORD) instead of
// on argv, where every process listing would carry them.
//
// nats-server reads no credential from the environment by itself, which is why
// this file has to exist at all.
func natsConf() []byte {
	return []byte(`# Rendered by the Semiont launcher. Contains no secret: the values are
# interpolated from this daemon's own environment at startup.
authorization {
  user: $NATS_USER
  password: $NATS_PASSWORD
}
`)
}

func browserClient(audience, addr string) map[string]any {
	c := publicClient(browserClientID, "Semiont Browser", audience)
	c["standardFlowEnabled"] = true
	c["redirectUris"] = browserRedirectUris(addr)
	c["webOrigins"] = []string{"+"}
	c["attributes"] = map[string]string{
		"pkce.code.challenge.method": "S256",
		"post.logout.redirect.uris":  "+",
	}
	return c
}

// browserRedirectUris: loopback entries carry NO PORT, which is what makes any
// port match.
//
// RFC 8252 §7.3 requires an authorization server to accept any port on a
// loopback redirect, because only software already on the user's machine can
// bind one — the port carries no security meaning there. Keycloak honours
// that rule, but only when the registered URI omits the port: pinning
// `localhost:3000` opts back out of it, and `semiont start --service browser
// --port 3001` then produces a healthy stack nobody can sign in to.
//
// The LAN address stays pinned. It is not loopback, so the rule does not
// apply and a wildcard port there would be a real widening.
func browserRedirectUris(addr string) []string {
	return []string{
		"http://localhost/*",
		"http://127.0.0.1/*",
		"http://" + addr + ":3000/*",
	}
}

// loopbackRedirectUris: the subset sync guarantees. It adds these when absent
// rather than replacing the list, because the LAN entry is deployment truth
// this command cannot re-derive — and because removing nothing is what makes
// sync safe to run against a realm someone has customised.
func loopbackRedirectUris() []string {
	return []string{"http://localhost/*", "http://127.0.0.1/*"}
}

func cliClient(audience string) map[string]any {
	c := publicClient(cliClientID, "Semiont launcher", audience)
	c["standardFlowEnabled"] = false
	c["attributes"] = map[string]string{
		"oauth2.device.authorization.grant.enabled": "true",
	}
	return c
}

func keycloakRealmJSON(realm, audience, addr string, accessTokenLifespan int, sidecarSecrets map[string]string) []byte {
	browser := browserClient(audience, addr)
	cli := cliClient(audience)
	clients := []map[string]any{browser, cli}
	// Ordered by `serviceClients`, not by map iteration: the rendered document
	// is compared against a golden, and Go randomises map order.
	for _, svc := range serviceClients {
		clients = append(clients, serviceAccountClient(svc, sidecarSecrets[svc], audience))
	}
	doc := map[string]any{
		"realm":               realm,
		"enabled":             true,
		"sslRequired":         "none",
		"accessTokenLifespan": accessTokenLifespan,
		"clients":             clients,
		"components": map[string]any{
			"org.keycloak.userprofile.UserProfileProvider": []map[string]any{{
				"providerId":    "declarative-user-profile",
				"subComponents": map[string]any{},
				"config": map[string]any{
					"kc.user.profile.config": []string{keycloakUserProfile()},
				},
			}},
		},
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		panic(err)
	}
	return append(b, '\n')
}

// keycloakUserProfile: the realm's declarative user profile, rendered as the
// JSON string Keycloak stores for it.
//
// `firstName` and `lastName` are required, so a person an administrator created
// an account for NAMES THEMSELVES at first login — Keycloak collects both before
// it lets them through. That is deliberate: Keycloak composes the `name` claim
// from these two, and that claim is what every event a person authors carries.
// The alternative is an administrator typing one string that something then has
// to split, and splitting a display name on a space gets "Mary Jane" and
// "van der Berg" wrong. Nobody here is willing to guess, so the person says.
//
// This is Keycloak's own default written out, so it changes nothing today. It is
// pinned for the reason keycloakAccessTokenLifespan is: inherited, the first-run
// experience moves with a Keycloak upgrade and differs on any other issuer, with
// no line to read back. An operator federating a different issuer owes Semiont
// only `email` — the gateway refuses a token carrying none, or carrying
// `email_verified` false.
func keycloakUserProfile() string {
	attribute := func(name string, required bool, validations map[string]any) map[string]any {
		a := map[string]any{
			"name":        name,
			"displayName": "${" + name + "}",
			"validations": validations,
			"permissions": map[string][]string{
				"view": {"admin", "user"},
				"edit": {"admin", "user"},
			},
			"multivalued": false,
		}
		if required {
			a["required"] = map[string][]string{"roles": {"user"}}
		}
		return a
	}
	personName := map[string]any{
		"length":                            map[string]int{"max": 255},
		"person-name-prohibited-characters": map[string]any{},
	}
	// encoding/json sorts map keys, so this renders identically every call —
	// which the realm golden depends on.
	doc := map[string]any{"attributes": []map[string]any{
		attribute("username", false, map[string]any{
			"length":                         map[string]int{"min": 3, "max": 255},
			"username-prohibited-characters": map[string]any{},
			"up-username-not-idn-homograph":  map[string]any{},
		}),
		attribute("email", true, map[string]any{
			"email":  map[string]any{},
			"length": map[string]int{"max": 255},
		}),
		attribute("firstName", true, personName),
		attribute("lastName", true, personName),
	}}
	b, err := json.Marshal(doc)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// publicClient: the shape both of Semiont's clients share — public (no
// secret, PKCE or device grant), no implicit or password grants, and the
// gateway audience stamped into access tokens.
func publicClient(clientID, name, audience string) map[string]any {
	return map[string]any{
		"clientId":                  clientID,
		"name":                      name,
		"enabled":                   true,
		"protocol":                  "openid-connect",
		"publicClient":              true,
		"implicitFlowEnabled":       false,
		"directAccessGrantsEnabled": false,
		"protocolMappers": []map[string]any{{
			"name":            "gateway audience",
			"protocol":        "openid-connect",
			"protocolMapper":  "oidc-audience-mapper",
			"consentRequired": false,
			"config": map[string]string{
				"included.custom.audience": audience,
				"access.token.claim":       "true",
				"id.token.claim":           "false",
			},
		}},
	}
}

// identityRunExtras: what a launched Keycloak needs beyond its plan row —
// its database on the [database] PostgreSQL (created there when the launcher
// runs that PostgreSQL), the realm file to import, and the bootstrap admin
// password. The password is per root and persisted: Keycloak creates the
// admin on its FIRST boot only, so a regenerated value would lock the
// console out of a realm that already exists.
// serviceClientSecrets: the per-root credential for every service client.
// Resolved once per start — the realm import needs them, and so does the
// preflight that checks the realm honoured them.
func serviceClientSecrets(x executor, root string) (map[string]string, bool) {
	secrets := map[string]string{}
	for _, svc := range serviceClients {
		secret, ok := x.serviceClientSecret(root, svc)
		if !ok {
			return nil, false
		}
		secrets[svc] = secret
	}
	return secrets, true
}

func identityRunExtras(x executor, fc flowCtx, addr string) ([]string, map[string]string, bool) {
	rp := fc.plan.Roles["identity"]
	db := fc.plan.Roles["database"]
	dbHost := db.Address
	if db.Obligation == obligationProvided {
		dbHost = addr
		if !x.createDatabase(envValue(rp.Env, "KC_DB_USERNAME"), keycloakDatabase) {
			return nil, nil, false
		}
	} else {
		x.say(sayLog, "identity — PostgreSQL at %s is not launcher-run; the %q database must already exist there", dbHost, keycloakDatabase)
		x.note("identity: external PostgreSQL at %s — the %q database must already exist there", dbHost, keycloakDatabase)
	}
	realm := keycloakRealm(issuerPath(rp.Issuer))
	// Resolved here and persisted per root, so the container that must PRESENT
	// each secret reads the same value out of the same file rather than having
	// it threaded through the start flow. Returned as well, because the
	// preflight checks these same values against the realm that imports them.
	secrets, ok := serviceClientSecrets(x, fc.root)
	if !ok {
		return nil, nil, false
	}
	realmFile, ok := x.stageRealm(realm, keycloakRealmJSON(realm, committedResource(fc.root), addr, rp.AccessTokenLifespan, secrets))
	if !ok {
		return nil, nil, false
	}
	password, ok := x.identityAdminPassword(fc.root)
	if !ok {
		return nil, nil, false
	}
	return []string{
		"-v", realmFile + ":/opt/keycloak/data/import/" + realm + ".json:ro",
		"-e", fmt.Sprintf("KC_DB_URL=jdbc:postgresql://%s:%d/%s", dbHost, db.Port, keycloakDatabase),
		"--env", "KC_BOOTSTRAP_ADMIN_PASSWORD=" + password,
	}, secrets, true
}
