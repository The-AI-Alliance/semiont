package launcher

// startargs.go — `semiont start`'s command line, turned into options or into
// the refusal an operator sees.
//
// Split from Start (LAUNCHER-PACKAGE-BOUNDARIES P3), where it was 190 of 543
// lines. These are RULES, not plumbing: which flags need a value, which
// contradict each other, which apply only to one placement or one service. A
// flag silently ignored is worse than one refused, which is why so many of
// them exist — and until this split none could be asserted without running a
// whole start.
//
// Refusals are RETURNED, not printed. The caller owns the ui and the exit
// code; this function owns the rules, and a returned string is a value a test
// can read.

import (
	"fmt"
	"strconv"
	"strings"
)

// parseStart: argv in, options out. `usage` means --help was asked for and the
// caller should print it; a non-empty message means the command line was
// refused and names why.
func parseStart(args []string) (opts startOptions, usage bool, errMsg string) {
	opts = startOptions{configName: "ollama-gemma", observe: true}

	// needVal reports a missing value rather than printing it — the whole
	// point here is that every refusal is a value a test can read.
	missing := ""
	needVal := func(i int) (string, bool) {
		if i+1 >= len(args) {
			missing = fmt.Sprintf("Missing value for %s", args[i])
			return "", false
		}
		return args[i+1], true
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if v, ok := strings.CutPrefix(a, "--ollama-cache="); ok {
			opts.ollamaCache = v
			continue
		}
		switch a {
		case "--config":
			v, ok := needVal(i)
			if !ok {
				return opts, false, missing
			}
			opts.configName = v
			opts.configSet = true
			i++
		case "--service":
			v, ok := needVal(i)
			if !ok {
				return opts, false, missing
			}
			opts.service = v
			i++
		case "--root":
			v, ok := needVal(i)
			if !ok {
				return opts, false, missing
			}
			opts.root = v
			i++
		case "--port":
			v, ok := needVal(i)
			if !ok {
				return opts, false, missing
			}
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 || n > 65535 {
				return opts, false, fmt.Sprintf("Invalid --port '%s' (expected 1-65535).", v)
			}
			opts.port = n
			i++
		case "--repo":
			v, ok := needVal(i)
			if !ok {
				return opts, false, missing
			}
			opts.repo = v
			i++
		case "--codespace":
			v, ok := needVal(i)
			if !ok {
				return opts, false, missing
			}
			opts.csName = v
			i++
		case "--machine":
			v, ok := needVal(i)
			if !ok {
				return opts, false, missing
			}
			opts.machine = v
			i++
		case "--idle-timeout":
			v, ok := needVal(i)
			if !ok {
				return opts, false, missing
			}
			opts.idleTimeout = v
			i++
		case "--retention-period":
			v, ok := needVal(i)
			if !ok {
				return opts, false, missing
			}
			opts.retention = v
			i++
		case "--list-configs":
			opts.listConfigs = true
		case "--clean-ollama":
			opts.cleanOllama = true
		case "--runtime":
			v, ok := needVal(i)
			if !ok {
				return opts, false, missing
			}
			opts.runtime = v
			i++
		case "--no-observe":
			opts.observe = false
			opts.noObserveSet = true
		case "--ollama-cache":
			v, ok := needVal(i)
			if !ok {
				return opts, false, missing
			}
			opts.ollamaCache = v
			i++
		case "--dry-run":
			opts.dryRun = true
		case "--quiet", "-q":
			opts.quiet = true
		case "--help", "-h":
			return opts, true, ""
		default:
			return opts, false, fmt.Sprintf("Unknown argument: %s", a)
		}
	}
	switch opts.ollamaCache {
	case "", "host", "volume":
	default:
		return opts, false, fmt.Sprintf("Unknown --ollama-cache '%s' (expected: host or volume)", opts.ollamaCache)
	}

	// Codespace placement: the codespace-only flags are rejected elsewhere,
	// and the local-only knobs are rejected on a codespace start — nothing
	// is silently ignored, per the flag-scoping pattern.
	if opts.runtime == "codespace" {
		switch {
		case opts.service != "":
			return opts, false, "--service does not apply to --runtime codespace (compose owns the services inside)."
		case opts.configSet:
			return opts, false, "--config does not apply to --runtime codespace (the codespace runs its committed config)."
		case opts.noObserveSet:
			return opts, false, "--no-observe does not apply to --runtime codespace (the observe profile is composed inside)."
		case opts.ollamaCache != "":
			return opts, false, "--ollama-cache does not apply to --runtime codespace."
		case opts.cleanOllama:
			return opts, false, "--clean-ollama does not apply to --runtime codespace."
		case opts.listConfigs:
			return opts, false, "--list-configs does not apply to --runtime codespace."
		case opts.root != "" && opts.repo != "":
			return opts, false, "--root and --repo are contradictory (one derives the repo from a clone, the other bypasses clones)."
		}
	} else if opts.repo != "" || opts.csName != "" || opts.machine != "" || opts.idleTimeout != "" || opts.retention != "" {
		return opts, false, "--repo/--codespace/--machine/--idle-timeout/--retention-period only apply to --runtime codespace."
	}
	if opts.port != 0 && (opts.service != "browser" || opts.runtime == "codespace") {
		return opts, false, "--port only applies to --service browser — every other port belongs to the KB's config (and a codespace forwards only its KB, on an allocated port)."
	}

	// --service compatibility: flags that don't apply to the named service are
	// rejected rather than silently ignored.
	if opts.service != "" {
		if !knownRole(opts.service) {
			return opts, false, fmt.Sprintf("Unknown --service '%s' (expected: %s)", opts.service, roleList)
		}
		switch {
		case opts.listConfigs:
			return opts, false, "--list-configs cannot be combined with --service."
		case opts.cleanOllama:
			return opts, false, "--clean-ollama cannot be combined with --service."
		case opts.noObserveSet:
			return opts, false, "--no-observe does not apply to --service: OTel export is enabled iff the collector is already running."
		case opts.ollamaCache != "" && opts.service != "inference":
			return opts, false, "--ollama-cache only applies to --service inference."
		case opts.configSet && configFreeService(opts.service):
			return opts, false, fmt.Sprintf("--config does not apply to --service %s (it reads no config).", opts.service)
		case opts.root != "" && configFreeService(opts.service):
			return opts, false, fmt.Sprintf("--root only applies to services that read the KB config (--service %s does not).", opts.service)
		}
	}

	// Dry-run output is a machine-consumable plan; keep the narration off it.
	return opts, false, ""
}
