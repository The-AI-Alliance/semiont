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

// selectVerbStack resolves the target. (nil, true) = the local stack;
// (non-nil, true) = that codespace stack; ok=false = refused, message
// printed with verb-specific fix-it lines.
func selectVerbStack(u *ui, verb string, ss *stackSet, repo string, wantLocal bool) (*stackState, bool) {
	cs := codespaceStacks(ss)
	local := ss.Stacks["local"]
	cwdRoot := cwdKBRoot()
	switch {
	case wantLocal:
	case repo != "":
		target := ss.Stacks["codespace:"+repo]
		if target == nil {
			u.fail("No codespace stack recorded for %s.", repo)
			for _, c := range cs {
				fmt.Fprintf(os.Stderr, "    recorded: %s\n", c.Repo)
			}
			return nil, false
		}
		return target, true
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
		u.fail("Multiple stacks are recorded — say which:")
		if local != nil {
			fmt.Fprintf(os.Stderr, "    semiont %s --runtime %s ...   (the local stack)\n", verb, local.Runtime)
		}
		for _, c := range cs {
			fmt.Fprintf(os.Stderr, "    semiont %s --repo %s ...\n", verb, c.Repo)
		}
		return nil, false
	}
	return nil, true
}
