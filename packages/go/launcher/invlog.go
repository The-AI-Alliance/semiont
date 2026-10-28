package launcher

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// logDir is where launcher logs live on this machine (logDirFor). "" when no
// home is resolvable.
func logDir() string {
	return logDirFor(systemName(), userHome(), os.Getenv("XDG_STATE_HOME"), os.Getenv("LOCALAPPDATA"))
}

// LogInvocation appends an "invoke" line for this run to launcher.log and
// returns the func that records the matching "exit" line (code + duration) —
// two events per run, so a crashed or killed launcher still leaves the
// invoke line as evidence. Best-effort throughout: logging never breaks the
// command, and --password values are redacted from the recorded argv.
func LogInvocation(args []string) func(int) {
	noop := func(int) {}
	dir := logDir()
	if dir == "" {
		return noop
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return noop
	}
	f, err := os.OpenFile(filepath.Join(dir, "launcher.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return noop
	}
	t0 := time.Now()
	cwd, _ := os.Getwd()
	argv := strings.Join(redactArgvForLog(args), " ")
	fmt.Fprintf(f, "%s invoke semiont %s (version %s, cwd %s)\n",
		t0.UTC().Format(time.RFC3339), argv, BuildVersion, cwd)
	return func(code int) {
		fmt.Fprintf(f, "%s exit %d semiont %s (%s)\n",
			time.Now().UTC().Format(time.RFC3339), code, argv, took(time.Since(t0)))
		f.Close()
	}
}

func redactArgvForLog(args []string) []string {
	out := make([]string, len(args))
	copy(out, args)
	for i := 0; i+1 < len(out); i++ {
		if out[i] == "--password" {
			out[i+1] = "<redacted>"
		}
	}
	return out
}
