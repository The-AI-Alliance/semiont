package launcher

// control_status.go — what semiont status reports, as the control API states
// it: the same rows the report prints (readRow, issuerServerRow,
// machineServedRow, browserRow), read once and stated as data.

import (
	"net/url"
	"strings"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// statusSnapshot: each knowledge base of views and of codespaces, and the
// services they share.
func statusSnapshot(ss *StackSet, views []stackView, cwd kbRoot, codespaces []*StackState) ControlStatusSnapshotResult {
	published := publishedKBs(ss)
	tokens := LoadTokens()
	out := ControlStatusSnapshotResult{KnowledgeBases: []ControlKnowledgeBaseStatus{}, Shared: sharedStatuses(views, ss)}
	for _, v := range views {
		if v.st == nil && v.key == "" {
			continue // no knowledge base: only the shared services are asked of
		}
		out.KnowledgeBases = append(out.KnowledgeBases, knowledgeBaseStatus(v, ss, cwd, published, tokens))
	}
	for _, c := range codespaces {
		out.KnowledgeBases = append(out.KnowledgeBases, codespaceStatus(c, codespaceStack(ss, c.Codespace.Repo) != nil, published, tokens))
	}
	return out
}

// knowledgeBaseStatus: v's knowledge base, and each of its own services, group
// by group, then the issuer it signs in at. A view no stack is recorded for is
// cwd's, discovered by its containers' names.
func knowledgeBaseStatus(v stackView, ss *StackSet, cwd kbRoot, published []publishedKB, tokens map[string]semiont.SignIn) ControlKnowledgeBaseStatus {
	kb := ControlKnowledgeBaseStatus{Name: v.name, Key: v.key, Recorded: v.st != nil,
		Placement: DiscoveredKBPlacementLocal, Services: []ControlServiceStatus{}}
	st := v.st
	root := cwd.dir
	if st != nil {
		root = st.KBRoot
	}
	kb.Root = stated(root)
	if root != "" {
		ident, err := readKBIdentity(root)
		if err != nil {
			kb.IdentityError = stated(err.Error())
		}
		if ident != nil {
			kb.Did, kb.SiteName = stated(ident.didWeb()), stated(ident.SiteName)
		}
	}
	if st != nil {
		// The record's identity is what was started.
		kb.Did = stated(st.KBDid)
		kb.Runtime = stated(st.Runtime)
		if base, err := GatewayBase(st); err == nil {
			kb.Gateway = &base
		}
		if ref, configured, err := storeSettingFor(v.key); err == nil {
			kb.SecretStore = stated(custodyStoreNamed(v.key, ref, configured).describe())
		}
		kb.Lan = stated(st.LanAddr)
		_, kb.Starting = startInProgress(v.key)
		kb.Session = sessionOf(StackKey(st), kb.Gateway, tokens)
		kb.Kb = publishedEntry(published, st)
	}

	healthy := true
	for _, g := range serviceGroups {
		if g.shared() {
			continue
		}
		for _, role := range g.roles {
			r := readRow(v, role, ss.Shared)
			healthy = healthy && (!r.counted("") || r.healthy)
			kb.Services = append(kb.Services, serviceStatus(r, g.name, r.counted(""), nil))
		}
	}
	issuer := readRow(v, "identity", ss.Shared)
	healthy = healthy && (!issuer.counted("") || issuer.healthy)
	signsIn := serviceStatus(issuer, groupOf("identity"), issuer.counted(""), nil)
	if issuer.rec != nil && issuer.rec.Provided == providedShared {
		signsIn.Realm = stated(keycloakRealm(issuerPath(issuer.probe)))
	}
	kb.Services = append(kb.Services, signsIn)
	kb.Healthy = healthy
	return kb
}

// codespaceStatus: a codespace's knowledge base, as this machine reaches it
// through its forward. Its services are its own launcher's to report.
func codespaceStatus(c *StackState, recorded bool, published []publishedKB, tokens map[string]semiont.SignIn) ControlKnowledgeBaseStatus {
	repo := c.Codespace.Repo
	kb := ControlKnowledgeBaseStatus{Name: repo, Key: StackKey(c), Recorded: recorded,
		Placement: DiscoveredKBPlacementCodespace, Repo: &repo, Did: stated(c.KBDid), Services: []ControlServiceStatus{}}
	if base, err := CodespaceBase(c); err == nil {
		kb.Gateway = &base
		kb.Healthy = httpOK(base + "/api/health")
	}
	kb.Session = sessionOf(StackKey(c), kb.Gateway, tokens)
	kb.Kb = publishedEntry(published, c)
	return kb
}

// publishedEntry: st's entry in the discovery document, nil when it has none.
func publishedEntry(published []publishedKB, st *StackState) *DiscoveredKB {
	for _, p := range published {
		if p.stack == st {
			kb := p.kb
			return &kb
		}
	}
	return nil
}

// sessionOf: the launcher's stored sign-in for the stack key, as the gateway
// at base judges its token; unverified when there is no base to ask.
func sessionOf(key string, base *string, tokens map[string]semiont.SignIn) *ControlSession {
	held, ok := tokens[key]
	if !ok {
		return &ControlSession{State: sessionNone}
	}
	state := sessionUnverified
	if base != nil {
		state = storedTokenState(*base, held.Token)
	}
	return &ControlSession{State: state, Email: stated(held.Email)}
}

// sharedStatuses: the services the knowledge bases of views share, group by
// group, each once, then each the machine serves for the knowledge bases that
// name it. The Browser is reported and never counted.
func sharedStatuses(views []stackView, ss *StackSet) []ControlServiceStatus {
	out := []ControlServiceStatus{}
	for _, g := range serviceGroups {
		if !g.shared() {
			continue
		}
		for _, role := range g.roles {
			switch role {
			case "browser":
				out = append(out, serviceStatus(browserRow(ss), g.name, false, nil))
				continue
			case "identity":
				r, serves := issuerServerRow(ss, views)
				out = append(out, serviceStatus(r, g.name, len(serves) > 0, serves))
				continue
			}
			rows, unconfigured := sharedRowsOf(role, views, ss)
			if len(rows) == 0 && unconfigured != nil {
				out = append(out, serviceStatus(*unconfigured, g.name, false, nil))
			}
			for _, s := range rows {
				var serves []string
				for _, v := range s.views {
					if v.name != "" {
						serves = append(serves, v.name)
					}
				}
				out = append(out, serviceStatus(s.row, g.name, s.row.counted(""), serves))
			}
		}
	}
	for _, role := range machineServedRoles {
		r, serves := machineServedRow(ss, views, role)
		if len(serves) == 0 && r.rec == nil {
			continue
		}
		out = append(out, serviceStatus(r, groupOf(role), len(serves) > 0, serves))
	}
	return out
}

// groupOf: the group role belongs to.
func groupOf(role string) string {
	for _, g := range serviceGroups {
		if contains(g.roles, role) {
			return g.name
		}
	}
	panic(role + " belongs to no group of serviceGroups")
}

// serviceStatus: r, a row of group, as the control API states a service.
// counted: whether its health is its knowledge base's; serves: the knowledge
// bases a shared service serves.
func serviceStatus(r statusRow, group string, counted bool, serves []string) ControlServiceStatus {
	s := ControlServiceStatus{Role: r.role, Group: group, Product: stated(r.product), Healthy: r.healthy, Counted: counted, Serves: serves}
	if r.unconfigured {
		s.State = "not-configured"
		return s
	}
	if r.rt != "—" {
		s.RunsOn = stated(r.rt)
	}
	switch r.word {
	case "running", "reachable", "unreachable", "absent":
		s.State = r.word
	default:
		s.State = "stopped"
		s.ContainerState = stated(r.word)
	}
	s.Probe = stated(r.probe)
	s.Page = pageOf(r)
	return s
}

// pageOf: the page a person opens of r's service — its descriptor's page, on
// the port its health is asked at — when it has one and it answers.
func pageOf(r statusRow) *string {
	driver := probeDriver(r.role)
	if r.rec != nil && r.rec.Driver != "" {
		driver = r.rec.Driver
	}
	page := descriptorFor(r.role, driver).page
	if page == "" || !r.healthy || !strings.HasPrefix(r.probe, "http") {
		return nil
	}
	at, err := url.Parse(r.probe)
	if err != nil {
		return nil
	}
	at.Path, at.RawQuery = page, ""
	return stated(at.String())
}
