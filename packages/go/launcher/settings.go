package launcher

// settings.go — `semiont settings`: every setting the launcher keeps, in one
// place. Each row reads its value through the function the start itself uses,
// so the listing cannot disagree with what a start does, and none reaches for
// a secret.

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
)

// setting: one setting `semiont settings` lists.
type setting struct {
	name string
	// flag distinguishes a machine-wide form of a knowledge-base setting:
	// secret-store --default.
	flag  string
	scope string
	// show: the value in effect and where it came from, one line per value.
	show func(u *UI, kb kbRoot) []settingLine
	// saves: where the setting is kept — the census's denominator
	// (TestEverySavedPreferenceIsASetting).
	saves []string
	// set records a value, validated as a start would validate it, so a
	// value a start would refuse is never recorded. unset returns the
	// setting to its default.
	set   func(u *UI, kb kbRoot, value string) bool
	unset func(u *UI, kb kbRoot) bool
	// changedBy: how a setting with no set is changed instead.
	changedBy func() string
	// detail: printed beneath the setting when it is shown alone.
	detail func(u *UI, kb kbRoot)
}

type settingLine struct{ value, source string }

// settingValueWidth: the value column of the listing.
const settingValueWidth = 44

// settingRowText: one line of the listing. A value that leaves room in its
// column has its explanation beside it; a wider one has it on the next line,
// under the value, so the two are never a single space apart.
func settingRowText(u *UI, label string, l settingLine) string {
	if utf8.RuneCountInString(l.value) < settingValueWidth {
		return fmt.Sprintf("  %-24s %-*s %s\n", label, settingValueWidth, l.value, u.Dim(l.source))
	}
	return fmt.Sprintf("  %-24s %s\n  %-24s %s\n", label, l.value, "", u.Dim(l.source))
}

const (
	scopeMachine = "machine"
	scopeKB      = "knowledge base"
)

var settingsTable = []setting{
	{name: "runtime", scope: scopeMachine, show: showRuntime, saves: []string{"rootsRegistry.Runtime"},
		set: setRuntime, unset: unsetRuntime},
	{name: "browser", scope: scopeMachine, show: showBrowserDocument, changedBy: editBrowserDocument},
	{name: "worker", scope: scopeMachine, show: showWorkerPoolDocument, changedBy: editWorkerPoolDocument},
	{name: "network", scope: scopeMachine, show: showNetwork, saves: []string{"rootsRegistry.Network"},
		set: setNetwork, unset: unsetNetwork},
	{name: "secret", scope: scopeMachine, show: showSecretSources, saves: []string{"rootsRegistry.Secrets"},
		changedBy: func() string { return "its own commands: semiont settings secret --help" }},
	{name: "secret-store", flag: "--default", scope: scopeMachine, show: showDefaultSecretStore,
		saves: []string{"storeSettingsFile.Default"}, set: setDefaultSecretStore, unset: unsetDefaultSecretStore},
	{name: "config", scope: scopeKB, show: showConfig, saves: []string{"rootEntry.Config"},
		set: setConfig, unset: unsetConfig},
	{name: "keycloak-port", scope: scopeKB, show: showKeycloakPort, saves: []string{"rootEntry.KeycloakPort"},
		set: setKeycloakPort, unset: unsetKeycloakPort},
	{name: "secret-store", scope: scopeKB, show: showSecretStoreSetting, saves: []string{"storeSettingsFile.Roots"},
		set: setSecretStore, unset: unsetSecretStore, detail: showSecretStoreLocations},
}

// registryBookkeeping: what roots.json keeps that is not a preference — the
// registry's own record of the knowledge bases this machine has used.
var registryBookkeeping = map[string]bool{
	"rootsRegistry.Schema": true, "rootsRegistry.Roots": true,
	"rootEntry.Path": true, "rootEntry.Did": true, "rootEntry.SiteName": true,
	"rootEntry.LastUsed": true, "rootEntry.LastStarted": true,
}

const settingsUsage = `Usage: semiont settings [<name> [<value> | --unset]] [--root <path|name>]
       semiont settings browser|worker --path

Every setting the launcher keeps: its value, and where the value came from.
Machine settings apply to every knowledge base on this machine; knowledge-base
settings to the one you are in, or the one --root names.

  semiont settings                   list every setting
  semiont settings <name>            show one
  semiont settings <name> <value>    set it (checked as a start would check it)
  semiont settings <name> --unset    return it to its default
  semiont settings browser --path    print where the Browser's document is,
                                     and nothing else
  semiont settings worker --path     print where the worker's document is,
                                     and nothing else

Settings:
  runtime         machine          The container runtime a start uses:
                                   container, docker or podman
  secret          machine          Where your own secrets come from (pointers,
                                   never values): semiont settings secret --help
  browser         machine          The Browser's document: the image, memory
                                   and port of the Browser this machine runs.
                                   Edit it; the next start runs what it says.
                                   The first command that needs it writes it.
  worker          machine          The worker's document: the image, memory
                                   and log level of the worker this machine
                                   does knowledge bases' jobs with. Edit it;
                                   the next start that runs a worker runs what
                                   it says. The first command that needs it
                                   writes it.
  network         machine          Who reaches a local stack: local, the
                                   default, this machine alone; or lan, where
                                   the network reaches its gateway and its
                                   issuer too, over plain HTTP. Apple
                                   container only.
  config          knowledge base   Which Inference document in
                                   .semiont/stack/inference/ a start runs
  keycloak-port   knowledge base   The port of this knowledge base's Keycloak
  secret-store    knowledge base   Where the values the launcher generates for
                                   the knowledge base are kept: op://<vault>,
                                   one 1Password item per knowledge base, or
                                   file, the default, which is plain files,
                                   not secure: for development only. Setting
                                   it moves every kept value, and refuses a
                                   store that already holds this knowledge
                                   base's values.
  secret-store --default
                  machine          The store a new knowledge base adopts at its
                                   first start: one with no setting and nothing
                                   kept in files. It moves no knowledge base's
                                   values; each keeps the store it adopted.

Showing a setting reads no secret and contacts no store. Changing the
secret-store contacts both stores, and shows every read, write and delete.
`

// Settings implements `semiont settings`.
func Settings(args []string) int {
	u := NewUI(false)
	if len(args) > 1 && args[0] == "secret" {
		return secretSourcesCmd(u, args[1:])
	}
	name, flag, value, rootArg, unset, pathOnly := "", "", "", "", false, false
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--help" || args[i] == "-h":
			fmt.Print(settingsUsage)
			return 0
		case args[i] == "--root":
			if i+1 >= len(args) {
				u.Fail("Missing value for --root")
				return 1
			}
			rootArg = args[i+1]
			i++
		case args[i] == "--unset":
			unset = true
		case args[i] == "--default":
			flag = "--default"
		case args[i] == "--path":
			pathOnly = true
		case name == "" && len(args[i]) > 0 && args[i][0] != '-':
			name = args[i]
		case name != "" && value == "" && len(args[i]) > 0 && args[i][0] != '-':
			value = args[i]
		default:
			u.Fail("Unknown argument: %s", args[i])
			fmt.Print(settingsUsage)
			return 1
		}
	}
	if pathOnly {
		if flag != "" || value != "" || unset {
			u.Fail("--path takes nothing else: semiont settings browser|worker --path")
			return 1
		}
		switch name {
		case "browser":
			return browserDocumentPathCmd()
		case "worker":
			return workerPoolDocumentPathCmd()
		}
		u.Fail("--path is for the Browser's and the worker's documents: semiont settings browser|worker --path")
		return 1
	}
	rows := settingsTable
	if name != "" {
		rows = nil
		for _, s := range settingsTable {
			if s.name == name && s.flag == flag {
				rows = append(rows, s)
			}
		}
		if rows == nil {
			u.Fail("Unknown setting %q.", strings.TrimSpace(name+" "+flag))
			fmt.Print(settingsUsage)
			return 1
		}
	}

	root := ""
	var ident *kbIdentity
	var rootErr error
	if rootArg != "" {
		root, ident, rootErr = resolveRootArg(rootArg)
	} else {
		root, _, ident, rootErr = resolveKBRoot()
	}
	if rootErr != nil && (rootArg != "" || projectFileRefused(rootErr)) {
		u.Fail("%v", rootErr)
		return 1
	}
	kb := kbRoot{dir: root, ident: ident}
	if value != "" || unset {
		return changeSetting(u, rows[0], kb, rootErr, value, unset)
	}

	for _, scope := range []string{scopeMachine, scopeKB} {
		var inScope []setting
		for _, s := range rows {
			if s.scope == scope {
				inScope = append(inScope, s)
			}
		}
		if len(inScope) == 0 {
			continue
		}
		switch {
		case scope == scopeMachine:
			fmt.Println(u.Bold("This machine"))
		case rootErr != nil:
			fmt.Println(u.Bold("A knowledge base"))
			fmt.Printf("  %s\n", u.Dim("(run inside one, or pass --root, to see its settings)"))
			continue
		default:
			fmt.Printf("%s %s\n", u.Bold("This knowledge base"), u.Dim(root))
		}
		for _, s := range inScope {
			for _, l := range s.show(u, kb) {
				fmt.Print(settingRowText(u, strings.TrimSpace(s.name+" "+s.flag), l))
			}
			if name != "" && s.detail != nil {
				s.detail(u, kb)
			}
		}
	}
	return 0
}

func showRuntime(u *UI, kb kbRoot) []settingLine {
	if rec := loadRoots().Runtime; rec != "" {
		if !onPath(rec) {
			return []settingLine{{rec, "recorded, but not on PATH: a start auto-detects"}}
		}
		return []settingLine{{rec, "recorded by a start with --runtime, or semiont settings"}}
	}
	if found := installedRuntimes(); len(found) > 0 {
		return []settingLine{{"auto-detect (" + found[0] + ")", "the default: the first of container, docker, podman on PATH"}}
	}
	return []settingLine{{"auto-detect", "the default; no runtime is on PATH"}}
}

func showSecretSources(u *UI, kb kbRoot) []settingLine {
	sources := loadRoots().Secrets
	if len(sources) == 0 {
		return []settingLine{{"none registered", "semiont settings secret set <VAR>"}}
	}
	vars := make([]string, 0, len(sources))
	for v := range sources {
		vars = append(vars, v)
	}
	sort.Strings(vars)
	var out []settingLine
	for _, v := range vars {
		out = append(out, settingLine{v + " ← " + refDisplay(sources[v]), "read at each start; the environment wins"})
	}
	return out
}

func showConfig(u *UI, kb kbRoot) []settingLine {
	if rec := recordedConfig(kb.dir); rec != "" {
		return []settingLine{{rec, "recorded by init, a start with --config, or semiont settings"}}
	}
	return []settingLine{{defaultConfigName, "the default"}}
}

func showKeycloakPort(u *UI, kb kbRoot) []settingLine {
	port, source, fromEnv, ok := keycloakPort(u, kb.dir)
	switch {
	case !ok:
		return []settingLine{{os.Getenv("KEYCLOAK_PORT"), "KEYCLOAK_PORT in the environment is not a port"}}
	case fromEnv:
		return []settingLine{{strconv.Itoa(port), "KEYCLOAK_PORT in the environment, which wins over what is recorded"}}
	case source == "default":
		return []settingLine{{strconv.Itoa(port), "Keycloak's default"}}
	}
	return []settingLine{{strconv.Itoa(port), "recorded by a start with KEYCLOAK_PORT, or semiont settings"}}
}

func showSecretStoreSetting(u *UI, kb kbRoot) []settingLine {
	key := kb.key()
	ref, configured, err := storeSettingFor(key)
	switch {
	case err != nil:
		return []settingLine{{"unknown", err.Error()}}
	case configured:
		return []settingLine{{custodyStoreNamed(key, ref, true).describe(), "set with semiont settings, or adopted from the default"}}
	}
	source := "the default"
	if def, set, _ := defaultStoreSetting(); set {
		source = "the default; with nothing kept yet, its first start adopts " + refDisplay(def)
	}
	return []settingLine{{custodyStoreNamed(key, ref, false).describe(), source}}
}

func showDefaultSecretStore(u *UI, kb kbRoot) []settingLine {
	def, set, err := defaultStoreSetting()
	switch {
	case err != nil:
		return []settingLine{{"unknown", err.Error()}}
	case set:
		return []settingLine{{custodyStoreNamed("<key>", def, true).describe(), "adopted by each new knowledge base"}}
	}
	return []settingLine{{"files", "new knowledge bases keep their values in " + fileStoreCaveat}}
}

// changeSetting sets or unsets one setting.
func changeSetting(u *UI, s setting, kb kbRoot, rootErr error, value string, unset bool) int {
	switch {
	case value != "" && unset:
		u.Fail("Give %s a value or --unset, not both.", s.name)
		return 1
	case s.set == nil:
		u.Fail("%s is changed by %s", s.name, s.changedBy())
		return 1
	case s.scope == scopeKB && rootErr != nil:
		u.Fail("%s is a knowledge-base setting: run inside one, or pass --root. (%v)", s.name, rootErr)
		return 1
	}
	ok := false
	if unset {
		ok = s.unset(u, kb)
	} else {
		ok = s.set(u, kb, value)
	}
	if !ok {
		return 1
	}
	for _, l := range s.show(u, kb) {
		u.Ok("%s: %s %s", s.name, l.value, u.Dim("("+l.source+")"))
	}
	return 0
}

// recorded reports a failed save.
func recorded(u *UI, err error) bool {
	if err != nil {
		u.Fail("Recording the setting: %v", err)
		return false
	}
	return true
}

func setRuntimePref(rt string) error {
	reg, err := readRoots()
	if err != nil {
		return err
	}
	reg.Runtime = rt
	return writeRoots(reg)
}

func setRuntime(u *UI, kb kbRoot, value string) bool {
	if _, ok := SelectRuntime(u, value); !ok {
		return false
	}
	return recorded(u, setRuntimePref(value))
}

func unsetRuntime(u *UI, kb kbRoot) bool { return recorded(u, setRuntimePref("")) }

// loadRootStack loads root's documents with its Inference document named
// name, refusing as a start would.
func loadRootStack(u *UI, root, name string) (*stack.Stack, bool) {
	if _, err := os.Stat(filepath.Join(root, stack.InferencePath(name))); err != nil {
		u.Fail("Config not found: %s", stack.InferencePath(name))
		return nil, false
	}
	st, err := stack.Load(root, name)
	if err == nil {
		_, err = derivePlan(st, descriptorFor("identity", "keycloak").defaultPort)
	}
	if err != nil {
		u.Fail("%v", err)
		return nil, false
	}
	return st, true
}

func setConfig(u *UI, kb kbRoot, value string) bool {
	if _, ok := loadRootStack(u, kb.dir, value); !ok {
		return false
	}
	return recorded(u, updateRootEntry(kb, func(e *rootEntry) { e.Config = value }))
}

// showBrowserDocument: where the Browser's document is, and what it says. It
// is shown as a start reads it, so showing one where there is none writes it,
// from the launcher's catalog, at the path the row names.
func showBrowserDocument(u *UI, kb kbRoot) []settingLine {
	doc, err := loadBrowserDocument(false)
	if err != nil {
		return []settingLine{{browserDocumentPath(), fmt.Sprintf("refused, and so is every start: %v", err)}}
	}
	return []settingLine{
		{doc.path, "the Browser's document: edit it, and the next start runs what it says"},
		{doc.spec.Image, "spec.image"},
		{doc.spec.Resources.Limits.Memory, "spec.resources.limits.memory"},
		{doc.endpoint(), "spec.port"},
	}
}

// editBrowserDocument: how the Browser's document is changed.
func editBrowserDocument() string {
	return "editing its document: " + browserDocumentPath()
}

// browserDocumentPathCmd: `semiont settings browser --path` — the document's
// path and nothing else, for a script that edits it; written first where there
// is none.
func browserDocumentPathCmd() int {
	doc, ok := readBrowserDocument(NewUI(true), false)
	if !ok {
		return 1
	}
	fmt.Println(doc.path)
	return 0
}

// showWorkerPoolDocument: where the worker's document is, and what it says.
// It is shown as a start reads it, so showing one where there is none writes
// it, from the launcher's catalog, at the path the row names.
func showWorkerPoolDocument(u *UI, kb kbRoot) []settingLine {
	doc, err := loadWorkerPoolDocument(false)
	if err != nil {
		return []settingLine{{workerPoolDocumentPath(), fmt.Sprintf("refused, and so is every start that runs a worker: %v", err)}}
	}
	return []settingLine{
		{doc.path, "the worker's document: edit it, and the next start that runs a worker runs what it says"},
		{doc.spec.Worker.Image, "spec.worker.image"},
		{doc.spec.Worker.Resources.Limits.Memory, "spec.worker.resources.limits.memory"},
		{string(doc.spec.LogLevel), "spec.logLevel"},
	}
}

// editWorkerPoolDocument: how the worker's document is changed.
func editWorkerPoolDocument() string {
	return "editing its document: " + workerPoolDocumentPath()
}

// workerPoolDocumentPathCmd: `semiont settings worker --path` — the
// document's path and nothing else, for a script that edits it; written first
// where there is none.
func workerPoolDocumentPathCmd() int {
	doc, ok := readWorkerPoolDocument(NewUI(true), false)
	if !ok {
		return 1
	}
	fmt.Println(doc.path)
	return 0
}

const (
	networkLocal = "local"
	networkLAN   = "lan"
)

// networkSetting: the network setting a start reads — local unless lan is
// recorded.
func networkSetting() string {
	if loadRoots().Network == networkLAN {
		return networkLAN
	}
	return networkLocal
}

func showNetwork(u *UI, kb kbRoot) []settingLine {
	if networkSetting() == networkLAN {
		return []settingLine{{networkLAN, "the gateway and the issuer answer the network, over plain HTTP; every start says so"}}
	}
	return []settingLine{{networkLocal, "the default: a stack answers this machine alone"}}
}

func setNetwork(u *UI, kb kbRoot, value string) bool {
	switch value {
	case networkLocal:
		return unsetNetwork(u, kb)
	case networkLAN:
		return recorded(u, setNetworkPref(networkLAN))
	}
	u.Fail("%q is not a network setting: local or lan.", value)
	return false
}

func unsetNetwork(u *UI, kb kbRoot) bool { return recorded(u, setNetworkPref("")) }

func setNetworkPref(network string) error {
	reg, err := readRoots()
	if err != nil {
		return err
	}
	reg.Network = network
	return writeRoots(reg)
}

func unsetConfig(u *UI, kb kbRoot) bool {
	return recorded(u, updateRootEntry(kb, func(e *rootEntry) { e.Config = "" }))
}

func setKeycloakPort(u *UI, kb kbRoot, value string) bool {
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		u.Fail("%q is not a port (1-65535).", value)
		return false
	}
	// The start's own rule: a port no Keycloak the launcher runs takes changes
	// nothing, and an ineffective setting is neither silent nor remembered.
	name := configForRealm(kb.dir)
	if name == "" {
		name = defaultConfigName
	}
	st, ok := loadRootStack(u, kb.dir, name)
	if !ok {
		return false
	}
	if st.Issuer == nil {
		u.Fail("%s trusts an issuer somebody else runs (spec.issuer.external), so a port setting would change nothing.", st.Files.KnowledgeBase)
		return false
	}
	if os.Getenv("KEYCLOAK_PORT") != "" {
		u.Warn("KEYCLOAK_PORT is set in this environment, and wins over the setting while it is.")
	}
	return recorded(u, updateRootEntry(kb, func(e *rootEntry) { e.KeycloakPort = port }))
}

func unsetKeycloakPort(u *UI, kb kbRoot) bool {
	return recorded(u, updateRootEntry(kb, func(e *rootEntry) { e.KeycloakPort = 0 }))
}
