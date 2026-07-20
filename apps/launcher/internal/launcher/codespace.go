package launcher

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// codespace.go — the "codespace" placement value on the runtime axis
// (.plans/CODESPACE-KB-LAUNCH.md §2). The REPO is the user-facing identity;
// the codespace NAME is a PID (shown by status, input only via the
// --codespace disambiguation corner). The launcher keeps at most ONE
// codespace per repo: it resumes what exists, and creates only when nothing
// does. Inside the codespace the stack stays on compose — the launcher
// orchestrates the outside only (create, wait, forward, credentials,
// lifecycle) by shelling out to `gh`, which owns auth and the tunnel client.

// The KB (backend, remote port 4000) is the ONLY port a codespace stack
// forwards: the browser's Knowledge Bases panel connects to KBs by
// host/port, so one browser works N codespace KBs at once — each stack gets
// its own local port, canonical 4000 when free, else the lowest free above
// it. Browser, sidecars, and infra stay inside the codespace (compose).
const kbRemotePort = 4000

// allocateKBPort picks this stack's local KB port: 4000, or the lowest
// free port above it — skipping every port other recorded stacks claim
// (local stack's port checks, other codespaces' forwards) and live holders.
func allocateKBPort(ss *stackSet, repo string) int {
	used := map[int]bool{}
	if local := ss.Stacks["local"]; local != nil {
		for _, p := range local.Ports {
			used[p] = true
		}
	}
	for _, c := range codespaceStacks(ss) {
		if c.Repo != repo && c.ForwardPort != 0 {
			used[c.ForwardPort] = true
		}
	}
	for port := kbRemotePort; ; port++ {
		if used[port] {
			continue
		}
		if out, err := capture("lsof", "-ti", fmt.Sprintf(":%d", port)); err == nil && out != "" {
			continue
		}
		return port
	}
}

var repoSlugRe = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)

// startCodespace is the whole §1 recipe as one blocking command, with
// local-start parity as the contract: preflight, create-or-resume, forward,
// health-gate, summary-and-exit.
func startCodespace(u *ui, opts startOptions) int {
	if !onPath("gh") {
		u.fail("--runtime codespace needs the GitHub CLI, and 'gh' is not on PATH.")
		fmt.Fprintln(os.Stderr, "  Install it: https://cli.github.com  (then: gh auth login)")
		return 1
	}

	// A local stack and codespace stacks COEXIST: the only local resource a
	// codespace needs is its one KB forward port, and allocateKBPort already
	// skips the local stack's recorded claims and any live holder. So the
	// local KB keeps 4000, a codespace KB takes 4001, and one browser works
	// both from its Knowledge Bases panel — the point of per-stack ports.
	ss := loadStackSet()

	// Identity ladder, repo-first (the repo IS the identity; many codespace
	// stacks may be recorded at once): --repo → root's origin (create-path
	// convenience) → the lone recorded codespace stack (bare resume works
	// from any directory). Several recorded and nothing named → say which.
	repo := opts.repo
	cs := codespaceStacks(ss)
	if repo == "" {
		if _, _, err := resolveKBRoot(); err == nil || opts.root != "" {
			var code int
			if repo, code = repoFromRoot(u, opts); code != 0 {
				return code
			}
		} else if len(cs) == 1 {
			repo = cs[0].Repo
		} else if len(cs) > 1 {
			u.fail("%d codespace stacks are recorded — say which:", len(cs))
			for _, c := range cs {
				fmt.Fprintf(os.Stderr, "    semiont start --runtime codespace --repo %s\n", c.Repo)
			}
			return 1
		} else {
			u.fail("No KB clone here and no codespace stack recorded.")
			fmt.Fprintln(os.Stderr, "  Pass --repo <owner>/<name>, or run from a KB clone (its origin supplies the repo).")
			return 1
		}
	} else if !repoSlugRe.MatchString(repo) {
		u.fail("--repo must be owner/name, got '%s'.", repo)
		return 1
	}
	st := ss.Stacks["codespace:"+repo]
	name, created := "", false
	if st != nil {
		name = st.Codespace
	}

	if opts.dryRun {
		renderCodespacePlan(opts, repo, name)
		return 0
	}

	u.log("KB repo: %s %s", u.bold(repo), u.dim("(codespace placement — the stack runs on a GitHub-hosted machine)"))

	// Preflights, early and loud — §1's silent/late failures become
	// first-second failures.
	if code := preflightGhScope(u); code != 0 {
		return code
	}
	secretOK := codespacesSecretSelected(repo)

	if name == "" {
		// No record: the cloud is the source of truth — adopt what exists,
		// create only when the repo truly has no codespace.
		instances, err := ghCodespaceList(repo)
		if err != nil {
			u.fail("Could not list codespaces (`gh codespace list`): %v", err)
			return 1
		}
		switch {
		case len(instances) == 0:
			if !secretOK {
				u.fail("ANTHROPIC_API_KEY is not a Codespaces user secret selected for %s — the stack would come up with inference dead, silently.", repo)
				// A codespace can't reach your local provider, so the
				// value must live in GitHub too. When a source is
				// registered, name the one command that bridges it.
				if ref, ok := loadRoots().Secrets["ANTHROPIC_API_KEY"]; ok {
					fmt.Fprintf(os.Stderr, "  You have a local source registered (%s). Push its current value:\n", refDisplay(ref))
					fmt.Fprintf(os.Stderr, "    semiont secret push ANTHROPIC_API_KEY --repo %s\n", repo)
				} else {
					fmt.Fprintln(os.Stderr, "  Fix:  gh secret set ANTHROPIC_API_KEY --user --app codespaces   (then select the repo)")
				}
				fmt.Fprintln(os.Stderr, "  Check:  gh api user/codespaces/secrets/ANTHROPIC_API_KEY/repositories")
				return 1
			}
			var code int
			if name, code = createCodespace(u, repo, opts); code != 0 {
				return code
			}
			created = true
		case len(instances) == 1:
			name = instances[0].Name
			u.log("Found existing codespace for %s: %s %s", repo, u.bold(name),
				u.dim("(state: "+instances[0].State+") — resuming, not creating"))
		default:
			if opts.csName != "" {
				for _, c := range instances {
					if c.Name == opts.csName {
						name = c.Name
					}
				}
				if name == "" {
					u.fail("--codespace '%s' is not among %s's codespaces.", opts.csName, repo)
					return 1
				}
			} else {
				u.fail("%s has %d codespaces — the launcher manages at most one per repo.", repo, len(instances))
				for _, c := range instances {
					fmt.Fprintf(os.Stderr, "    %s  (%s)\n", c.Name, c.State)
				}
				fmt.Fprintln(os.Stderr, "  Pick one with --codespace <name>, or delete extras:  gh codespace delete -c <name>")
				return 1
			}
		}
	} else {
		u.log("Resuming recorded codespace %s %s", u.bold(name), u.dim("("+repo+")"))
		if !secretOK {
			u.warn("ANTHROPIC_API_KEY is not selected for %s in the Codespaces user secrets — inference may be dead inside the stack.", repo)
		}
		// A dead recorded forward is normal here; a live one means the
		// stack is already reachable and respawning would fail the binds.
		if forwardProcAlive(st.ForwardPID) { // zombie or healthy, it must go before respawn
			_ = syscall.Kill(st.ForwardPID, syscall.SIGTERM)
			time.Sleep(200 * time.Millisecond)
		}
	}

	// --machine only chooses hardware at creation. Resuming or adopting an
	// existing codespace can't change its VM class, so say so rather than
	// letting the flag look effective.
	if opts.machine != "" && !created {
		u.warn("--machine %s ignored: %s already exists and keeps the class it was created with.", opts.machine, name)
	}

	// One KB port per stack — other codespaces' forwards keep running;
	// concurrency is the point. Allocation dodges every recorded claim and
	// live holder, so nothing needs displacing.
	kbPort := allocateKBPort(ss, repo)
	if !requirePortFree(u, kbPort, "KB (forward)") {
		return 1
	}
	// The VM must be Available before a tunnel to it can bind — measured
	// 2026-07-20: `ports forward` against a stopped codespace TRIGGERS the
	// wake and then dies, leaving the launcher waiting on a tunnel that
	// will never exist. So ensure Available first, waking explicitly when
	// stopped.
	if code := ensureCodespaceAvailable(u, repo, name); code != 0 {
		return code
	}
	pid, code := spawnForward(u, name, kbPort)
	if code != 0 {
		return code
	}
	// A forward that never binds is the failure mode that wasted the whole
	// health budget in testing: gh can exit, or stay up forwarding nothing.
	// Confirm the port actually answers before gating on the stack.
	bound := false
	for i := 0; i < 30; i++ {
		if forwardAlive(pid, kbPort) {
			bound = true
			break
		}
		time.Sleep(time.Second)
	}
	if !bound {
		u.fail("The port forward did not come up on localhost:%d within 30s.", kbPort)
		fmt.Fprintf(os.Stderr, "  Try it directly:  gh codespace ports forward %d:%d -c %s\n", kbRemotePort, kbPort, name)
		return 1
	}

	// The record binds the stack to its executor before the health gate —
	// belief, verified by status; a failed wait leaves an honest record.
	newSt := &stackState{
		Runtime: "codespace", Codespace: name, Repo: repo,
		ForwardPID: pid, ForwardPort: kbPort, Ports: []int{kbPort},
		Services: map[string]serviceState{},
	}
	saveStack(newSt)

	// Health, not VM state, is readiness ("Available ≠ hooks finished" —
	// on a fresh create the devcontainer hooks run minutes past Available).
	u.log("Waiting for the stack %s", u.dim("(a fresh create runs devcontainer hooks — image and model pulls take minutes)"))
	d, ok := waitForHTTP(u, "KB (through the forward)", fmt.Sprintf("http://localhost:%d/api/health", kbPort), 600)
	if !ok {
		return 1
	}
	u.ok("KB healthy %s", u.dim("("+took(d)+")"))

	creds := fetchAdminCreds(u, name)

	fmt.Println()
	fmt.Printf("%s  %s\n", u.wrap(ansiBold+ansiGreen, "🚀 Semiont KB is up in codespace "+name), u.dim("("+took(d)+" to healthy)"))
	fmt.Println()
	fmt.Printf("  Semiont KB         %s %s\n", u.bold(fmt.Sprintf("http://localhost:%d", kbPort)),
		u.dim("(add Host localhost, Port "+fmt.Sprintf("%d", kbPort)+" in the browser's Knowledge Bases panel)"))
	// The browser is NOT forwarded — only the KB is. It runs locally and
	// connects to any number of KBs, cloud or local; without this pointer a
	// codespace-only user has no browser at all.
	if httpOK("http://localhost:3000") {
		fmt.Printf("  Semiont Browser    %s %s\n", u.bold("http://localhost:3000"), u.dim("(already running)"))
	} else {
		fmt.Printf("  Semiont Browser    %s %s\n", u.bold("semiont start --service frontend"),
			u.dim("(runs locally; one browser works any number of KBs)"))
	}
	fmt.Println()
	fmt.Printf("  %s\n", u.dim("Runs "+repo+" as pushed — local uncommitted changes don't travel."))
	if creds != nil {
		fmt.Printf("  Connect as %s / %s %s\n",
			u.bold(creds.Email), u.bold(creds.Password), u.dim("(generated at creation; never stored by the launcher)"))
	}
	fmt.Println()
	fmt.Printf("  Check health:  %s\n", u.bold("semiont status"))
	fmt.Printf("  Follow logs:   %s %s\n", u.bold("semiont logs --repo "+repo), u.dim("(bare logs when unambiguous)"))
	fmt.Printf("  Halt billing:  %s %s\n", u.bold("semiont stop --repo "+repo), u.dim("(state persists; --delete destroys)"))
	fmt.Println()
	return 0
}

// repoFromRoot: the create-path convenience — resolve the KB root as usual
// and read the slug from its origin remote.
func repoFromRoot(u *ui, opts startOptions) (string, int) {
	var root string
	var err error
	if opts.root != "" {
		root, err = resolveRootArg(opts.root)
	} else {
		root, _, err = resolveKBRoot()
	}
	if err != nil {
		u.fail("%v", err)
		fmt.Fprintln(os.Stderr, "  Pass --repo <owner>/<name>, or run from a KB clone (its origin supplies the repo).")
		return "", 1
	}
	origin, err := capture("git", "-C", root, "remote", "get-url", "origin")
	if err != nil || origin == "" {
		u.fail("Cannot read the origin remote of %s.", root)
		fmt.Fprintln(os.Stderr, "  Pass --repo <owner>/<name>.")
		return "", 1
	}
	slug, ok := parseGitHubSlug(origin)
	if !ok {
		u.fail("The origin of %s is not a GitHub repo (%s) — codespaces are GitHub-only.", root, origin)
		fmt.Fprintln(os.Stderr, "  Pass --repo <owner>/<name>, or run from a GitHub clone.")
		return "", 1
	}
	// Pushed-state honesty: locally an uncommitted config edit is live via
	// the /kb bind mount; in a codespace it silently doesn't exist.
	if out, err := capture("git", "-C", root, "status", "--porcelain"); err == nil && out != "" {
		u.warn("%s has uncommitted changes — the codespace runs %s as PUSHED; they don't travel.", root, slug)
	}
	return slug, 0
}

// parseGitHubSlug: owner/name from either remote form —
// git@github.com:owner/name(.git) or https://github.com/owner/name(.git).
func parseGitHubSlug(origin string) (string, bool) {
	s := origin
	switch {
	case strings.HasPrefix(s, "git@github.com:"):
		s = strings.TrimPrefix(s, "git@github.com:")
	case strings.HasPrefix(s, "https://github.com/"):
		s = strings.TrimPrefix(s, "https://github.com/")
	case strings.HasPrefix(s, "ssh://git@github.com/"):
		s = strings.TrimPrefix(s, "ssh://git@github.com/")
	default:
		return "", false
	}
	s = strings.TrimSuffix(strings.TrimSuffix(s, "/"), ".git")
	if !repoSlugRe.MatchString(s) {
		return "", false
	}
	return s, true
}

// preflightGhScope: §1 precondition 1 — the scope gap otherwise surfaces
// later as a misleading "must have admin rights to Repository".
func preflightGhScope(u *ui) int {
	out, err := captureBoth("gh", "auth", "status")
	if err != nil {
		u.fail("gh is not authenticated.")
		fmt.Fprintln(os.Stderr, "  Run:  gh auth login")
		return 1
	}
	if !strings.Contains(out, "codespace") {
		u.fail("The gh token is missing the 'codespace' scope (it surfaces later as a misleading admin-rights error).")
		fmt.Fprintln(os.Stderr, "  Grant it:  gh auth refresh -h github.com -s codespace")
		return 1
	}
	return 0
}

// codespacesSecretSelected: §1 precondition 2 — ANTHROPIC_API_KEY as a
// Codespaces user secret with the repo selected. Without it the stack comes
// up with inference dead, silently.
func codespacesSecretSelected(repo string) bool {
	out, err := capture("gh", "api", "user/codespaces/secrets/ANTHROPIC_API_KEY/repositories")
	if err != nil {
		return false
	}
	return strings.Contains(out, `"`+repo+`"`) || strings.Contains(out, `"full_name":"`+repo+`"`) ||
		strings.Contains(out, `"full_name": "`+repo+`"`)
}

type codespaceInstance struct {
	Name       string `json:"name"`
	State      string `json:"state"`
	Repository string `json:"repository"`
}

func ghCodespaceList(repo string) ([]codespaceInstance, error) {
	out, err := capture("gh", "codespace", "list", "--json", "name,state,repository")
	if err != nil {
		return nil, err
	}
	var all []codespaceInstance
	if err := json.Unmarshal([]byte(out), &all); err != nil {
		return nil, fmt.Errorf("unexpected `gh codespace list` output: %v", err)
	}
	var mine []codespaceInstance
	for _, c := range all {
		if strings.EqualFold(c.Repository, repo) {
			mine = append(mine, c)
		}
	}
	return mine, nil
}

type codespaceMachine struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	CPUs        int    `json:"cpus"`
	MemoryBytes int64  `json:"memory_in_bytes"`
}

// availableMachines: the machine classes GitHub offers THIS user for THIS
// repo. Verified 2026-07-20: the list is filtered by the devcontainer's
// `hostRequirements` — a repo declaring 4c/16gb is not offered the 2-core
// class, while a repo with no devcontainer is. So anything in this list is
// adequate by the KB's OWN declaration, which is what makes falling back to
// another class safe rather than reckless (an undersized VM would fail
// slowly, at the health gate, after minutes of pulls).
func availableMachines(repo string) ([]codespaceMachine, string, error) {
	out, err := captureBoth("gh", "api", "/repos/"+repo+"/codespaces/machines")
	if err != nil {
		return nil, out, err
	}
	var resp struct {
		Machines []codespaceMachine `json:"machines"`
	}
	if json.Unmarshal([]byte(out), &resp) != nil {
		return nil, out, fmt.Errorf("unexpected response")
	}
	return resp.Machines, out, nil
}

// chooseMachine resolves the VM class for a create. An EXPLICIT request must
// actually be available — never substitute for something the user asked for
// by name. Implicitly: premiumLinux when offered (the recipe's verified
// choice), else the largest available by cores, announced with the reason —
// premium-then-largest rather than always-largest, so an account with
// largePremiumLinux isn't silently upgraded to a costlier VM.
func chooseMachine(u *ui, repo, requested string) (string, int) {
	machines, raw, err := availableMachines(repo)
	if err != nil {
		u.fail("Could not list machine classes for %s: %s", repo, strings.TrimSpace(raw))
		fmt.Fprintln(os.Stderr, "  Likely causes: the account has no Codespaces access, or an org policy restricts machine types.")
		return "", 1
	}
	if len(machines) == 0 {
		u.fail("GitHub offers no machine classes for %s.", repo)
		fmt.Fprintln(os.Stderr, "  Likely causes: an org policy restricts machine types, or the devcontainer's hostRequirements exceed every class available to you.")
		return "", 1
	}
	if requested != "" {
		for _, m := range machines {
			if m.Name == requested {
				return requested, 0
			}
		}
		u.fail("--machine %s is not available to you for %s. Available:", requested, repo)
		for _, m := range machines {
			fmt.Fprintf(os.Stderr, "    %-20s %s\n", m.Name, m.DisplayName)
		}
		return "", 1
	}
	for _, m := range machines {
		if m.Name == "premiumLinux" {
			return m.Name, 0
		}
	}
	best := machines[0]
	for _, m := range machines[1:] {
		if m.CPUs > best.CPUs || (m.CPUs == best.CPUs && m.MemoryBytes > best.MemoryBytes) {
			best = m
		}
	}
	u.warn("premiumLinux isn't available to you for %s — using %s (%s).", repo, best.Name, best.DisplayName)
	return best.Name, 0
}

// createCodespace with the §1 503-aware backoff: GitHub-side incidents are
// retried (bounded), everything else fails with the CLI's own words.
func createCodespace(u *ui, repo string, opts startOptions) (string, int) {
	machine, code := chooseMachine(u, repo, opts.machine)
	if code != 0 {
		return "", code
	}
	u.log("Creating codespace for %s %s", u.bold(repo), u.dim("(--machine "+machine+"; ~4 min to Available, hooks run minutes past it)"))
	u.echoCmd("gh", "codespace", "create", "--repo", repo, "--machine", machine)
	for attempt := 1; ; attempt++ {
		out, err := captureBoth("gh", "codespace", "create", "--repo", repo, "--machine", machine)
		if err == nil {
			lines := strings.Fields(out)
			if len(lines) == 0 {
				u.fail("`gh codespace create` printed no codespace name.")
				return "", 1
			}
			return lines[len(lines)-1], 0
		}
		if strings.Contains(out, "503") && attempt < 5 {
			u.warn("GitHub returned 503 (their side — attempt %d/5); retrying in %ds...", attempt, attempt*2)
			time.Sleep(time.Duration(attempt*2) * time.Second)
			continue
		}
		u.fail("Create failed: %s", strings.TrimSpace(out))
		return "", 1
	}
}

// ensureCodespaceAvailable gets the VM to Available before anything tries to
// tunnel to it. A stopped codespace resumes BECAUSE something connects, so
// there is a trigger step: `gh codespace ssh -- true` both wakes it and
// blocks until it is connectable (measured: ~19s), which also proves the
// ssh path the credentials read needs.
func ensureCodespaceAvailable(u *ui, repo, name string) int {
	state := ""
	if instances, err := ghCodespaceList(repo); err == nil {
		for _, c := range instances {
			if c.Name == name {
				state = c.State
			}
		}
	}
	if state == "Available" {
		return 0
	}
	if state == "Shutdown" {
		u.log("Codespace is stopped — waking it %s", u.dim("(connecting is what resumes a codespace; ~20s)"))
		if err := runSilent("gh", "codespace", "ssh", "-c", name, "--", "true"); err != nil {
			u.fail("Could not wake codespace %s.", name)
			fmt.Fprintln(os.Stderr, "  Check it:  gh codespace list")
			return 1
		}
	}
	return waitCodespaceAvailable(u, repo, name)
}

// waitCodespaceAvailable polls until GitHub reports the VM Available.
// Post-CREATE only: a fresh codespace is Provisioning for minutes and
// forwarding before then cannot bind. Never call it for a stopped
// codespace — those wake on connection, so this would wait forever.
func waitCodespaceAvailable(u *ui, repo, name string) int {
	for i := 0; i < 300; i++ {
		instances, err := ghCodespaceList(repo)
		if err == nil {
			for _, c := range instances {
				if c.Name == name && c.State == "Available" {
					return 0
				}
			}
		}
		if i == 0 {
			u.log("Waiting for the codespace VM %s", u.dim("(GitHub reports Provisioning until the machine is up)"))
		}
		time.Sleep(2 * time.Second)
	}
	u.fail("Codespace %s did not reach Available within 10 minutes.", name)
	fmt.Fprintln(os.Stderr, "  Check it:  gh codespace list")
	return 1
}

// spawnForward starts the detached dev-tunnel forward for this stack's KB
// port — a long-lived process the bring-up-and-exit launcher deliberately
// leaves behind, PID + port recorded (status re-establishes it, stop kills
// it). Each codespace stack runs its own.
func spawnForward(u *ui, name string, kbPort int) (int, int) {
	// Argument order is <codespacePort>:<localPort> — NOT the reverse.
	// Getting it backwards forwards a port nothing serves onto a local port
	// something else may already own: gh then fails to bind but the process
	// STAYS ALIVE, so it looks healthy while forwarding nothing. The §1
	// recipe's symmetric 4000:4000 example hides the order; live testing
	// found it.
	args := []string{"codespace", "ports", "forward",
		fmt.Sprintf("%d:%d", kbRemotePort, kbPort), "-c", name}
	u.echoCmd("gh", args...)
	cmd := exec.Command("gh", args...)
	cmd.Stdout, cmd.Stderr = nil, nil
	if err := cmd.Start(); err != nil {
		u.fail("Could not start the port forward: %v", err)
		return 0, 1
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	u.log("Port forward running %s", u.dim(fmt.Sprintf("(detached, pid %d — recorded; semiont stop ends it)", pid)))
	return pid, 0
}

type adminCreds struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// fetchAdminCreds reads the §1 credentials — generated once at post-create
// INSIDE the codespace. Mirror image of `semiont secret` (an output, not an
// input) but same discipline: announced before the reach, read fresh,
// displayed on purpose, never persisted or logged. An unreadable admin.json
// (the pre-sshd-feature gap) degrades with the fix named — never blocks a
// healthy stack.
func fetchAdminCreds(u *ui, name string) *adminCreds {
	// ABSOLUTE (globbed) path: `gh codespace ssh` lands in /home/vscode, not
	// the workspace, so the relative form the recipe used silently fails
	// with "No such file or directory". The glob expands remotely and does
	// not depend on the workspace directory's name. Found live 2026-07-20.
	const credPath = "/workspaces/*/.devcontainer/admin.json"
	u.log("Reading admin credentials %s", u.dim("(gh codespace ssh -c "+name+" -- cat "+credPath+" — generated at creation, never stored locally)"))
	out, err := capture("gh", "codespace", "ssh", "-c", name, "--", "cat", credPath)
	if err != nil {
		// Two very different causes; naming only the rare one (as this
		// message used to) misdiagnoses the common case out loud.
		u.warn("Could not read admin credentials over ssh yet.")
		fmt.Println("    Usually this means setup is still finishing inside the codespace (sshd comes up with it) —")
		fmt.Println("    semiont status re-reads them. If it persists, the devcontainer may predate the sshd feature:")
		fmt.Println("    recreate from current main, or read them in the codespace terminal: cat .devcontainer/admin.json")
		return nil
	}
	var c adminCreds
	if json.Unmarshal([]byte(out), &c) != nil || c.Email == "" {
		u.warn("admin.json was unreadable; see the codespace's .devcontainer/admin.json directly.")
		return nil
	}
	return &c
}

// renderCodespacePlan is --dry-run for the codespace placement: the gh
// commands a real run would execute. Reaches for nothing.
func renderCodespacePlan(opts startOptions, repo, recorded string) {
	fmt.Println("# semiont start --runtime codespace --dry-run — the gh commands a real run")
	fmt.Println("# would execute, in order. Values known only at runtime appear as <placeholders>.")
	fmt.Println(`gh auth status                                   # preflight: 'codespace' scope`)
	fmt.Println("gh api user/codespaces/secrets/ANTHROPIC_API_KEY/repositories   # preflight: secret selected for " + repo)
	if recorded != "" {
		fmt.Println("# recorded codespace: " + recorded + " — resume (no create)")
	} else {
		fmt.Println("gh codespace list --json name,state,repository   # adopt-or-create decision for " + repo)
		machine := opts.machine
		if machine == "" {
			machine = "<machine>"
			fmt.Println("gh api /repos/" + repo + "/codespaces/machines   # preflight: classes available for this repo (hostRequirements-filtered)")
			fmt.Println("# <machine> = premiumLinux when available, else the largest offered")
		} else {
			fmt.Println("gh api /repos/" + repo + "/codespaces/machines   # preflight: verify --machine " + machine + " is available")
		}
		fmt.Println("gh codespace create --repo " + repo + " --machine " + machine + "   # only when none exists (503-aware retry)")
	}
	fmt.Println("gh codespace ports forward 4000:<kb-port> -c <codespace>   # <codespacePort>:<localPort>; detached; pid + port recorded")
	fmt.Println("# wait: http://localhost:<kb-port>/api/health (600s)")
	fmt.Println("gh codespace ssh -c <codespace> -- cat .devcontainer/admin.json   # credentials (displayed, never stored)")
}

// stopCodespace: `semiont stop` for a codespace stack. Stop halts billing
// and KEEPS the record — the rule is that the record mirrors existence, and
// a stopped codespace still exists (state, credentials, billing identity).
// --delete destroys and forgets. Both kill the recorded forward first.
func stopCodespace(u *ui, st *stackState, service string, del, dryRun bool) int {
	if service != "" {
		u.fail("--service does not apply to a codespace stack (compose owns the services inside).")
		return 1
	}
	if dryRun {
		fmt.Println("# semiont stop --dry-run — the exact commands a real run would execute.")
		if st.ForwardPID != 0 {
			fmt.Printf("# kill the recorded port forward (pid %d)\n", st.ForwardPID)
		}
		if del {
			fmt.Println("gh codespace delete -c " + st.Codespace + " --force")
			fmt.Println("# forget stack.json (the codespace no longer exists)")
		} else {
			fmt.Println("gh codespace stop -c " + st.Codespace)
			fmt.Println("# keep stack.json (the codespace still exists — state and credentials persist)")
		}
		return 0
	}
	// Verify port release only when THIS stack held the lens — another
	// codespace's live forward legitimately holds the same local ports.
	hadLens := forwardProcAlive(st.ForwardPID)
	if hadLens {
		u.log("Stopping the port forward %s", u.dim(fmt.Sprintf("(pid %d)", st.ForwardPID)))
		_ = syscall.Kill(st.ForwardPID, syscall.SIGTERM)
	}
	if del {
		u.log("Deleting codespace %s %s", u.bold(st.Codespace), u.dim("("+st.Repo+" — destroys its state and credentials)"))
		u.echoCmd("gh", "codespace", "delete", "-c", st.Codespace, "--force")
		if out, err := captureBoth("gh", "codespace", "delete", "-c", st.Codespace, "--force"); err != nil {
			u.fail("Delete failed: %s", strings.TrimSpace(out))
			return 1
		}
		forgetStack("codespace:" + st.Repo)
		if hadLens {
			verifyPortsReleased(u, st.Ports)
		}
		fmt.Println("Codespace deleted — stack, state, and credentials destroyed.")
		return 0
	}
	u.log("Stopping codespace %s %s", u.bold(st.Codespace), u.dim("("+st.Repo+" — billing halts; state persists)"))
	u.echoCmd("gh", "codespace", "stop", "-c", st.Codespace)
	if out, err := captureBoth("gh", "codespace", "stop", "-c", st.Codespace); err != nil {
		u.fail("Stop failed: %s", strings.TrimSpace(out))
		return 1
	}
	st.ForwardPID = 0
	saveStack(st)
	if hadLens {
		verifyPortsReleased(u, st.Ports)
	}
	fmt.Println("Codespace stopped — billing halted; state and credentials persist.")
	fmt.Println("  Resume:   semiont start")
	fmt.Println("  Destroy:  semiont stop --delete")
	return 0
}

// statusCodespace: `semiont status` for a codespace stack — VM state from
// gh, health through the forwards (re-established if the recorded one
// died), credentials read fresh, and a LOCAL section that doesn't pretend
// the remote VM's directories are here.
func statusCodespace(u *ui, st *stackState) int {
	fmt.Println()
	fmt.Println("  CODESPACE")
	state := "unknown"
	if instances, err := ghCodespaceList(st.Repo); err == nil {
		state = "deleted"
		for _, c := range instances {
			if c.Name == st.Codespace {
				state = c.State
			}
		}
	}
	fmt.Printf("  %s  %s %s\n", u.bold(st.Codespace), st.Repo, u.dim("(state: "+state+")"))
	switch state {
	case "deleted":
		u.warn("The recorded codespace no longer exists — forget the record with: semiont stop --delete")
		printRoots(u, st)
		return 1
	case "Available":
	case "Shutdown":
		fmt.Printf("  %s\n", u.dim("stopped — state and credentials persist; compute billing halted (storage still bills)"))
		fmt.Printf("  Resume:   %s\n", u.bold("semiont start"))
		printRoots(u, st)
		return 1
	default:
		// Queued / Provisioning / Starting / Rebuilding / Failed …: coming
		// up (and billing) — NOT stopped. Saying "stopped, billing halted"
		// here would be wrong on both counts.
		fmt.Printf("  %s\n", u.dim("not ready yet (state: "+state+") — GitHub is still working on it; re-run semiont status"))
		printRoots(u, st)
		return 1
	}

	if !forwardAlive(st.ForwardPID, st.ForwardPort) {
		u.log("Recorded KB forward is not running — re-establishing")
		if st.ForwardPort == 0 {
			st.ForwardPort = allocateKBPort(loadStackSet(), st.Repo)
		}
		if pid, code := spawnForward(u, st.Codespace, st.ForwardPort); code == 0 {
			st.ForwardPID = pid
			saveStack(st)
		}
	}

	fmt.Println()
	url := fmt.Sprintf("http://localhost:%d/api/health", st.ForwardPort)
	healthy := false
	for i := 0; i < 10; i++ { // a just-respawned forward needs a beat
		if httpOK(url) {
			healthy = true
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	mark := u.wrap(ansiGreen, "healthy")
	if !healthy {
		mark = u.wrap(ansiRed, "unreachable")
	}
	fmt.Printf("  KB          %s  %s\n", mark, u.dim(url))
	fmt.Printf("  %s\n", u.dim("(browser, sidecars, and infra run inside the codespace via compose)"))

	if creds := fetchAdminCreds(u, st.Codespace); creds != nil {
		fmt.Printf("  Connect (Host localhost, Port %d) as %s / %s\n", st.ForwardPort, u.bold(creds.Email), u.bold(creds.Password))
	}

	fmt.Println()
	fmt.Println("  LOCAL")
	fmt.Printf("  state      %s\n", statePath())
	fmt.Printf("  forward    pid %d %s\n", st.ForwardPID, u.dim(fmt.Sprintf("(KB localhost:%d → codespace:%d)", st.ForwardPort, kbRemotePort)))

	printRoots(u, st)
	if healthy {
		return 0
	}
	return 1
}

// forwardedStacks: every codespace stack with a live KB forward — any
// number may be forwarded at once, each on its own local port.
func forwardedStacks(cs []*stackState) []*stackState {
	var out []*stackState
	for _, c := range cs {
		if forwardAlive(c.ForwardPID, c.ForwardPort) {
			out = append(out, c)
		}
	}
	return out
}

// dropCollidingForwards kills codespace forwards squatting on ports a local
// start is about to claim — and only those; forwards on allocated offset
// ports keep running (concurrent KBs are the point). A dropped forward is a
// view, not a stack: nothing stops in the cloud (announced, with the
// re-attach command — which will re-allocate around the local stack).
func dropCollidingForwards(u *ui, needs []portNeed) {
	claimed := map[int]bool{}
	for _, p := range needs {
		claimed[p.port] = true
	}
	for _, st := range codespaceStacks(loadStackSet()) {
		if forwardProcAlive(st.ForwardPID) && claimed[st.ForwardPort] {
			u.warn("Dropping %s's KB forward on port %d — the local stack needs it; the codespace keeps running (re-attach: semiont start --runtime codespace --repo %s).",
				st.Repo, st.ForwardPort, st.Repo)
			_ = syscall.Kill(st.ForwardPID, syscall.SIGTERM)
			st.ForwardPID = 0
			saveStack(st)
			time.Sleep(200 * time.Millisecond) // let the bind release
		}
	}
}

// printStacksOverview: the fleet view — every recorded stack, its state,
// and which codespace holds the lens. One gh list serves all of them.
func printStacksOverview(u *ui, local *stackState, cs []*stackState) {
	fmt.Println()
	fmt.Println("  STACKS")
	states := map[string]string{}
	if onPath("gh") {
		if out, err := capture("gh", "codespace", "list", "--json", "name,state,repository"); err == nil {
			var all []codespaceInstance
			if json.Unmarshal([]byte(out), &all) == nil {
				for _, c := range all {
					states[c.Name] = c.State
				}
			}
		}
	}
	if local != nil {
		fmt.Printf("  local      %s %s\n", local.KBRoot, u.dim("("+local.Runtime+")"))
	}
	for _, c := range cs {
		state := states[c.Codespace]
		if state == "" {
			state = "deleted?"
		}
		fwd := ""
		if forwardAlive(c.ForwardPID, c.ForwardPort) {
			fwd = "  " + u.bold(fmt.Sprintf("KB localhost:%d", c.ForwardPort))
		}
		fmt.Printf("  codespace  %s  %s %s%s\n", c.Repo, c.Codespace, u.dim("("+state+")"), fwd)
	}
}

// captureBoth: trimmed stdout+stderr combined — gh writes diagnostics (auth
// status, HTTP errors) to stderr.
func captureBoth(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// forwardProcAlive: is the recorded PID still OUR forward PROCESS? A bare
// liveness signal is not enough — PIDs get reused, and trusting (or worse,
// SIGTERMing) a recycled PID hits an unrelated process. The PID counts only
// if it is alive AND running gh. Use this for cleanup decisions.
func forwardProcAlive(pid int) bool {
	if pid == 0 || syscall.Kill(pid, 0) != nil {
		return false
	}
	comm, err := capture("ps", "-p", fmt.Sprintf("%d", pid), "-o", "comm=")
	return err == nil && strings.Contains(comm, "gh")
}

// forwardAlive: is the forward actually FORWARDING? A live gh process can
// fail to bind (wrong port order, port taken, codespace not ready) and stay
// running — a zombie that every pid-only check calls healthy while nothing
// reaches the KB. Observed live 2026-07-20. So the port must answer too.
func forwardAlive(pid, port int) bool {
	if !forwardProcAlive(pid) || port == 0 {
		return false
	}
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}
