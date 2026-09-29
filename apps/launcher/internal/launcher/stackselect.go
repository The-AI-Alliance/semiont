package launcher

// stackselect.go — which recorded stack does a knowledge verb (useradd,
// login, yield) target? One ladder, shared: explicit --repo wins; the cwd's
// clone disambiguates; a lone stack answers for itself; anything ambiguous
// refuses with a menu rather than guessing — acting on the wrong KB is not
// something to do silently.

import (
	"fmt"
	"os"
)

// SelectVerbStack resolves the target. (nil, true) = the local stack;
// (non-nil, true) = that codespace stack; ok=false = refused, message
// printed with verb-specific fix-it lines.
func SelectVerbStack(u *UI, verb string, ss *StackSet, repo string, wantLocal bool) (*StackState, bool) {
	// Nine verbs resolve their target through here, so this is also where
	// they all learn that the record could not be read — without it every
	// one of them would say "needs a running stack, and none is recorded"
	// about a stack that is up.
	if ss.refuseUnreadable(u) {
		return nil, false
	}
	// The contradiction check lives HERE, once — a verb that forgot it
	// would silently resolve --repo+--runtime to the local stack (the
	// wantLocal arm wins the switch), targeting the wrong KB.
	if repo != "" && wantLocal {
		u.Fail("--repo and --runtime are contradictory: one names a codespace stack, the other the local one.")
		return nil, false
	}
	cs := codespaceStacks(ss)
	local := ss.Stacks["local"]
	cwdRoot := CwdKBRoot()
	switch {
	case wantLocal:
	case repo != "":
		return repoCodespaceStack(u, ss, repo)
	// Standing in the clone whose stack is running: the cwd says "local" —
	// demanding --runtime here made the user restate the prompt (same rule
	// stop and start keep).
	case local != nil && local.KBRoot != "" && local.KBRoot == cwdRoot:
	case local != nil && len(cs) == 0:
	case local == nil && len(cs) == 1:
		return cs[0], true
	case local == nil && len(cs) == 0:
	default:
		// No local stack, several codespaces: this clone's origin may name
		// one — the same convenience repoFromRoot gives start.
		if local == nil {
			if c := originCodespace(cs, cwdRoot); c != nil {
				return c, true
			}
		}
		u.Fail("Multiple stacks are recorded — say which:")
		if local != nil {
			fmt.Fprintf(os.Stderr, "    semiont %s --runtime %s ...   (the local stack)\n", verb, local.Runtime)
		}
		for _, c := range cs {
			fmt.Fprintf(os.Stderr, "    semiont %s --repo %s ...\n", verb, c.Codespace.Repo)
		}
		return nil, false
	}
	return nil, true
}

// repoCodespaceStack: the stack a --repo names — its record, or, on a miss,
// the codespace GitHub says the repo has, adopted as start adopts it. THE
// lookup for every --repo verb: five sites used to refuse a codespace that
// start would have resumed. Adoption writes nothing; the verbs that change
// the codespace or forward it (stop, status) record what they did.
func repoCodespaceStack(u *UI, ss *StackSet, repo string) (*StackState, bool) {
	if st := codespaceStack(ss, repo); st != nil {
		return st, true
	}
	if !requireGh(u, "Finding "+repo+"'s codespace") {
		return nil, false
	}
	name, found, ok := adoptRepoCodespace(u, repo, "")
	if !ok {
		return nil, false
	}
	if !found {
		u.Fail("%s has no codespace.", repo)
		for _, c := range codespaceStacks(ss) {
			fmt.Fprintf(os.Stderr, "    recorded: %s\n", c.Codespace.Repo)
		}
		fmt.Fprintln(os.Stderr, "  Start one:  semiont start --runtime codespace --repo "+repo)
		return nil, false
	}
	return &StackState{Codespace: &codespacePlacement{Name: name, Repo: repo}, Services: map[string]ServiceState{}}, true
}

// ForwardedBase: the URL a verb dials for a codespace stack's KB — its
// forward on this machine. An adopted codespace has none until start (or
// status) establishes it, so refuse with that remedy rather than dial
// localhost:0.
func ForwardedBase(u *UI, target *StackState, verb string) (string, bool) {
	if target.Codespace.ForwardPort == 0 {
		u.Fail("%s's codespace %s is not forwarded to this machine, so %s cannot reach its KB.", target.Codespace.Repo, target.Codespace.Name, verb)
		fmt.Fprintln(os.Stderr, "  Resume it and forward the KB:  semiont start --runtime codespace --repo "+target.Codespace.Repo)
		return "", false
	}
	return fmt.Sprintf("http://localhost:%d", target.Codespace.ForwardPort), true
}
