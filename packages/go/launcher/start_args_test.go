package launcher

import (
	"slices"
	"strings"
	"testing"
)

// The flag rules live in parseStart, which returns its refusals rather than
// printing them. Those rules — which flags need a value, which contradict,
// which apply only to a placement or a service — were 190 of Start's 543
// lines, reachable only by running a whole start. They decide whether an
// operator is understood or refused, and nothing could assert them directly.
func TestParseStartDefaults(t *testing.T) {
	opts, usage, msg := parseStart(nil)
	if usage || msg != "" {
		t.Fatalf("a bare start was not accepted: usage=%v msg=%q", usage, msg)
	}
	if opts.configName != "ollama-gemma" {
		t.Errorf("configName = %q, want the default", opts.configName)
	}
	if !opts.observe {
		t.Error("observe defaults off; the collector runs on every start")
	}
	if opts.configSet {
		t.Error("configSet is true without --config, which makes a default look like a choice")
	}
}

func TestParseStartReadsValues(t *testing.T) {
	// No --port here: it applies to --service browser alone, which the refusal
	// table below pins. Written otherwise first, and the parser was right.
	opts, _, msg := parseStart([]string{"--config", "cloud", "--service", "gateway", "--runtime", "docker"})
	if msg != "" {
		t.Fatalf("refused a valid command line: %s", msg)
	}
	if opts.configName != "cloud" || !opts.configSet {
		t.Errorf("--config not recorded: %q set=%v", opts.configName, opts.configSet)
	}
	if !slices.Equal(memberRoles(opts.starts), []string{"gateway"}) || opts.runtime != "docker" {
		t.Errorf("flags not recorded: %+v", opts)
	}
}

// A group's flags are checked against every service it could start: the index
// starts the inference it needs when that is not up, so --ollama-cache applies.
// The start narrows the services to what is not up once it reads what runs.
func TestParseStartGroupReach(t *testing.T) {
	opts, _, msg := parseStart([]string{"--group", "index", "--ollama-cache", "host", "--config", "cloud"})
	if msg != "" {
		t.Fatalf("refused a valid command line: %s", msg)
	}
	if opts.group.name != "index" || opts.asked() != "--group index" {
		t.Errorf("group not recorded: %q, asked %q", opts.group.name, opts.asked())
	}
	if got := memberRoles(opts.starts); !slices.Equal(got, memberRoles(groupStarts(mustGroup(t, "index"), func(string) bool { return false }))) {
		t.Errorf("reach = %v, want every service the index could start", got)
	}
	if _, _, msg := parseStart([]string{"--group", "telemetry"}); msg != "" {
		t.Errorf("--group telemetry refused: %s", msg)
	}
}

// `--ollama-cache=host` and `--ollama-cache host` are the same flag; only one
// of the two forms went through the switch.
func TestParseStartAcceptsBothOllamaCacheForms(t *testing.T) {
	for _, args := range [][]string{
		{"--ollama-cache=volume"},
		{"--ollama-cache", "volume"},
	} {
		if opts, _, msg := parseStart(args); msg != "" || opts.ollamaCache != "volume" {
			t.Errorf("%v → %q (msg %q)", args, opts.ollamaCache, msg)
		}
	}
}

func TestParseStartHelpIsNotAnError(t *testing.T) {
	for _, flag := range []string{"--help", "-h"} {
		if _, usage, msg := parseStart([]string{flag}); !usage || msg != "" {
			t.Errorf("%s → usage=%v msg=%q", flag, usage, msg)
		}
	}
}

// Every refusal, as one table. A flag that is silently ignored is worse than
// one that is refused, which is why these exist at all.
func TestParseStartRefusals(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want string // a distinctive fragment of the refusal
	}{
		{"missing value", []string{"--config"}, "Missing value for --config"},
		{"unknown flag", []string{"--nope"}, "Unknown argument: --nope"},
		{"port, which the Browser's document says", []string{"--service", "browser", "--port", "3001"}, "Unknown argument: --port"},
		{"bad ollama cache", []string{"--ollama-cache", "nfs"}, "Unknown --ollama-cache"},
		{"unknown service", []string{"--service", "nosuch"}, "Unknown --service"},

		// Codespace placement: the codespace's own launcher runs the inside,
		// so the local knobs cannot apply and are refused rather than ignored.
		{"codespace + service", []string{"--runtime", "codespace", "--service", "gateway"}, "--service does not apply"},
		{"codespace + config", []string{"--runtime", "codespace", "--config", "cloud"}, "--config does not apply"},
		{"codespace + no-observe", []string{"--runtime", "codespace", "--no-observe"}, "--no-observe does not apply"},
		{"codespace + ollama-cache", []string{"--runtime", "codespace", "--ollama-cache", "host"}, "--ollama-cache does not apply"},
		{"codespace + clean-ollama", []string{"--runtime", "codespace", "--clean-ollama"}, "--clean-ollama does not apply"},
		{"codespace + list-configs", []string{"--runtime", "codespace", "--list-configs"}, "--list-configs does not apply"},
		{"root and repo", []string{"--runtime", "codespace", "--root", "/k", "--repo", "o/n"}, "contradictory"},

		// The reverse: codespace-only flags on a local start.
		{"repo without codespace", []string{"--repo", "o/n"}, "only apply to --runtime codespace"},
		{"machine without codespace", []string{"--machine", "big"}, "only apply to --runtime codespace"},

		// --service compatibility.
		{"service + list-configs", []string{"--service", "gateway", "--list-configs"}, "cannot be combined"},
		{"service + clean-ollama", []string{"--service", "gateway", "--clean-ollama"}, "cannot be combined"},
		{"service + no-observe", []string{"--service", "gateway", "--no-observe"}, "--no-observe does not apply to --service"},
		{"ollama-cache on non-inference", []string{"--service", "gateway", "--ollama-cache", "host"}, "only applies to a start that runs inference (--service gateway does not)"},

		// --group: a known name, alone, on a local start, and the same
		// compatibility over every service it could start.
		{"group missing value", []string{"--group"}, "Missing value for --group"},
		{"unknown group", []string{"--group", "nosuch"}, "Unknown --group 'nosuch' (expected: record, index, issuer, knowledge-workers, providers, or telemetry)"},
		{"group and service", []string{"--group", "index", "--service", "gateway"}, "--group and --service are contradictory"},
		{"codespace + group", []string{"--runtime", "codespace", "--group", "index"}, "--group does not apply to --runtime codespace"},
		{"group + list-configs", []string{"--group", "index", "--list-configs"}, "--list-configs cannot be combined with --group."},
		{"group + clean-ollama", []string{"--group", "index", "--clean-ollama"}, "--clean-ollama cannot be combined with --group."},
		{"group + no-observe", []string{"--group", "index", "--no-observe"}, "--no-observe does not apply to --group"},
		{"ollama-cache on a group that runs no inference", []string{"--group", "issuer", "--ollama-cache", "host"}, "(--group issuer does not)"},
		{"config on a config-free group", []string{"--group", "telemetry", "--config", "cloud"}, "--config does not apply to --group telemetry (it reads no config)."},
		{"root on a config-free group", []string{"--group", "telemetry", "--root", "/k"}, "(--group telemetry does not)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, msg := parseStart(tc.args)
			if msg == "" {
				t.Fatalf("%v was accepted; want a refusal naming %q", tc.args, tc.want)
			}
			if !strings.Contains(msg, tc.want) {
				t.Errorf("refusal was %q, want it to name %q", msg, tc.want)
			}
		})
	}
}
