package launcher

// stackselect.go — which recorded stack does a knowledge verb (useradd,
// login, yield) target? One ladder, shared: explicit --repo or --root wins;
// the knowledge base you stand in disambiguates; a lone stack answers for
// itself; anything ambiguous refuses with a menu rather than guessing —
// acting on the wrong KB is not something to do silently.

import (
	"errors"
	"fmt"
	"os"
)

// SelectVerbStack resolves a verb's target: the recorded stack it acts on — a
// codespace's when its Codespace is set, else a local one — or nil when no
// stack is recorded and none was named, which each verb refuses in its own
// words. ok=false = refused, message printed with verb-specific fix-it lines.
//
// --repo names a codespace stack and --root a local one; else the stack of the
// knowledge base you stand in; else the one stack recorded; else, with no
// local stack, the codespace this clone's origin names. --runtime narrows the
// choice to the local stacks.
func SelectVerbStack(u *UI, verb string, ss *StackSet, repo, root string, wantLocal bool) (*StackState, bool) {
	// Every knowledge verb resolves its target through here, so this is also
	// where they all learn that the record could not be read — without it
	// every one of them would say "needs a running stack, and none is
	// recorded" about a stack that is up.
	if ss.refuseUnreadable(u) {
		return nil, false
	}
	// The contradiction check lives HERE, once — a verb that forgot it would
	// silently resolve one of them and ignore the other, targeting the wrong
	// KB.
	if repo != "" && (wantLocal || root != "") {
		u.Fail("--repo and --root or --runtime are contradictory: one names a codespace stack, the other a local one.")
		return nil, false
	}
	if repo != "" {
		return repoCodespaceStack(u, ss, repo)
	}
	if root != "" {
		return rootLocalStack(u, ss, root)
	}
	cwdRoot, err := CwdKBRoot()
	if err != nil {
		u.Fail("%v", err)
		return nil, false
	}
	locals, cs := localStacks(ss), codespaceStacks(ss)
	// Standing in the clone whose stack is running says which: demanding a
	// flag here would make the user restate the prompt (same rule stop and
	// start keep).
	for _, st := range locals {
		if cwdRoot != "" && st.KBRoot == cwdRoot {
			return st, true
		}
	}
	if wantLocal {
		cs = nil
	}
	switch {
	case len(locals) == 0 && len(cs) == 0:
		return nil, true
	case len(locals) == 1 && len(cs) == 0:
		return locals[0], true
	case len(locals) == 0 && len(cs) == 1:
		return cs[0], true
	case len(locals) == 0:
		// Several codespaces: this clone's origin may name one — the same
		// convenience repoFromRoot gives start.
		if c := originCodespace(cs, cwdRoot); c != nil {
			return c, true
		}
	}
	u.Fail("Multiple stacks are recorded — say which:")
	printStackMenu(verb, "", locals, cs)
	return nil, false
}

// printStackMenu lists the commands that name each of the stacks, for a
// refusal to choose among them; flag is any flag the asked-for command
// carried (stop's --delete) that the choices must repeat.
func printStackMenu(verb, flag string, locals, cs []*StackState) {
	for _, st := range locals {
		fmt.Fprintf(os.Stderr, "    semiont %s --root %s%s ...\n", verb, st.KBRoot, flag)
	}
	for _, c := range cs {
		fmt.Fprintf(os.Stderr, "    semiont %s --repo %s%s ...\n", verb, c.Codespace.Repo, flag)
	}
}

// rootLocalStack: the recorded local stack of the knowledge base at root, as
// --root names it. A machine runs one copy of a knowledge base, so the record
// of its did is that copy's, and one running from another clone is not the
// stack root names.
func rootLocalStack(u *UI, ss *StackSet, root string) (*StackState, bool) {
	dir, ident, err := resolveRootArg(root)
	if err != nil {
		u.Fail("%v", err)
		return nil, false
	}
	st := localStack(ss, kbRoot{dir: dir, ident: ident}.key())
	switch {
	case st == nil:
		u.Fail("No stack of %s is recorded (per %s).", dir, statePath())
		fmt.Fprintln(os.Stderr, "  Start it:  semiont start --root "+dir)
		return nil, false
	case st.KBRoot != dir:
		u.Fail("%s's stack runs from %s, not %s (per %s).", ident.didWeb(), st.KBRoot, dir, statePath())
		return nil, false
	}
	return st, true
}

// repoCodespaceStack: the stack a --repo names — its record, or, on a miss,
// the codespace GitHub says the repo has, adopted as start adopts it. THE
// lookup for every --repo verb, so none refuses a codespace that start would
// resume. Adoption writes nothing; the verbs that change the codespace or
// forward it (stop, status) record what they did.
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

// CodespaceUnreachable: a codespace stack whose KB this machine cannot reach.
// An adopted codespace has no forward until start establishes it; a recorded
// forward that is down is re-established by status, when the codespace is
// running, and status says how to resume one that is not.
type CodespaceUnreachable struct {
	Repo, Name string
	// Recorded: a forward is recorded on this machine, and it is down.
	Recorded bool
}

func (c *CodespaceUnreachable) Error() string {
	if c.Recorded {
		return fmt.Sprintf("%s's codespace %s is forwarded to this machine, and the forward is down", c.Repo, c.Name)
	}
	return fmt.Sprintf("%s's codespace %s is not forwarded to this machine", c.Repo, c.Name)
}

// Remedy is the command that restores the forward, and what it is said as.
func (c *CodespaceUnreachable) Remedy() (said, command string) {
	if c.Recorded {
		return "Re-establish the forward", "semiont status --repo " + c.Repo
	}
	return "Resume it and forward the KB", "semiont start --runtime codespace --repo " + c.Repo
}

// CodespaceBase: the URL that reaches a codespace stack's KB, its forward on
// this machine, when one is recorded and up (forwardAlive: the process is
// ours and the port answers); a *CodespaceUnreachable otherwise. Nothing is
// started: a forward's lifetime is the commands' that own it.
func CodespaceBase(target *StackState) (string, error) {
	cs := target.Codespace
	if cs.ForwardPort == 0 {
		return "", &CodespaceUnreachable{Repo: cs.Repo, Name: cs.Name}
	}
	if !forwardAlive(cs.ForwardPID, cs.ForwardPort) {
		return "", &CodespaceUnreachable{Repo: cs.Repo, Name: cs.Name, Recorded: true}
	}
	return fmt.Sprintf("http://localhost:%d", cs.ForwardPort), nil
}

// forwardedBase: the URL a verb dials for a codespace stack's KB
// (CodespaceBase). ok=false: it cannot be reached, which was said for verb
// with the command that restores it.
func forwardedBase(u *UI, target *StackState, verb string) (string, bool) {
	base, err := CodespaceBase(target)
	var unreachable *CodespaceUnreachable
	if errors.As(err, &unreachable) {
		u.Fail("%v, so %s cannot reach its KB.", unreachable, verb)
		said, command := unreachable.Remedy()
		fmt.Fprintf(os.Stderr, "  %s:  %s\n", said, command)
		return "", false
	}
	return base, true
}
