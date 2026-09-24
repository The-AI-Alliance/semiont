package launcher

import (
	"strings"
	"testing"
)

// LAUNCHER-PACKAGE-BOUNDARIES P3. The flag rules — which flags need a value,
// which contradict, which apply only to a placement or a service — were 190 of
// Start's 543 lines, reachable only by running a whole start. They decide
// whether an operator is understood or refused, and nothing could assert them
// directly.
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
	if opts.service != "gateway" || opts.runtime != "docker" {
		t.Errorf("flags not recorded: %+v", opts)
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
		{"port not a number", []string{"--port", "x"}, "Invalid --port"},
		{"port out of range", []string{"--port", "70000"}, "Invalid --port"},
		{"bad ollama cache", []string{"--ollama-cache", "nfs"}, "Unknown --ollama-cache"},
		{"unknown service", []string{"--service", "nosuch"}, "Unknown --service"},

		// Codespace placement: compose owns the inside, so the local knobs
		// cannot apply and are refused rather than ignored.
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

		// --port belongs to the Browser alone; every other port is config.
		{"port without browser", []string{"--port", "3001"}, "--port only applies to --service browser"},

		// --service compatibility.
		{"service + list-configs", []string{"--service", "gateway", "--list-configs"}, "cannot be combined"},
		{"service + clean-ollama", []string{"--service", "gateway", "--clean-ollama"}, "cannot be combined"},
		{"service + no-observe", []string{"--service", "gateway", "--no-observe"}, "--no-observe does not apply to --service"},
		{"ollama-cache on non-inference", []string{"--service", "gateway", "--ollama-cache", "host"}, "only applies to --service inference"},
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

// The combination that must NOT be refused: --port with --service browser is
// the whole reason --port exists.
func TestParseStartAcceptsThePortMove(t *testing.T) {
	if _, _, msg := parseStart([]string{"--service", "browser", "--port", "3001"}); msg != "" {
		t.Errorf("the port move was refused: %s", msg)
	}
}
