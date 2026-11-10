package launcher

// control_ops.go — each method of the control API, run by the code its
// command runs: the command itself, given the params as the command line it
// reads (stack.start, stack.stop), or the operation the command prints
// (the rest), with the request's UI saying its lines.

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/launcher/stack"
	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

// controlHandler runs one request's operation, saying what it does through u:
// its result, or why it failed.
type controlHandler func(req *controlRequest, u *UI) (any, *controlFailure)

// controlHandlers: the handler of each method of controlMethods
// (TestEveryControlMethodHasAHandler).
var controlHandlers = map[string]controlHandler{
	"launcher.about":  controlAbout,
	"roots.list":      controlRootsList,
	"roots.init":      controlRootsInit,
	"roots.forget":    controlRootsForget,
	"status.snapshot": controlStatusSnapshot,
	"stack.start":     controlStackStart,
	"stack.stop":      controlStackStop,
	"auth.login":      controlAuthLogin,
	"auth.logout":     controlAuthLogout,
	"logs.follow":     controlLogsFollow,
	"settings.list":   controlSettingsList,
	"settings.get":    controlSettingsGet,
	"settings.set":    controlSettingsSet,
	"settings.unset":  controlSettingsUnset,
	"settings.path":   controlSettingsPath,
}

// operate runs req's operation. A panic in it is the launcher's failure, and
// fails the request alone.
func (req *controlRequest) operate() (result any, failure *controlFailure) {
	defer func() {
		if p := recover(); p != nil {
			fmt.Fprintf(req.server.diag, "✗ control: %s panicked: %v\n", req.method.name, p)
			result, failure = nil, &controlFailure{code: controlCodeFailed, rpcCode: rpcInternalError,
				message: fmt.Sprintf("the launcher failed: %v", p)}
		}
	}()
	return controlHandlers[req.method.name](req, req.ui())
}

// decode reads req's params, which checkParams held to their schema, into p.
func (req *controlRequest) decode(p any) *controlFailure {
	if err := json.Unmarshal(req.params, p); err != nil {
		return &controlFailure{code: controlCodeInvalidParams, rpcCode: rpcInvalidParams,
			message: fmt.Sprintf("%s's params: %v", req.method.name, err)}
	}
	return nil
}

// stated: v's address, or nil for its zero value — an optional member of a
// result stated only when there is something to state.
func stated[T comparable](v T) *T {
	var zero T
	if v == zero {
		return nil
	}
	return &v
}

// given: what an optional param names, "" when it is absent.
func given(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// asked: whether an optional flag param is given, and true.
func asked(v *bool) bool { return v != nil && *v }

func controlAbout(req *controlRequest, u *UI) (any, *controlFailure) {
	about := ControlAboutResult{
		Development:   BuildVersion == unstampedVersion,
		ApiVersions:   []string{controlAPIVersion},
		ImageRegistry: imageRegistry,
		Runtimes:      []ControlRuntimeState{},
	}
	if !about.Development {
		about.Version = stated(BuildVersion)
	}
	if BuildCommit != unstampedCommit {
		about.Commit = stated(BuildCommit)
	}
	if BuildDate != unstampedDate {
		about.Built = stated(BuildDate)
	}
	for _, rt := range runtimeOrder {
		about.Runtimes = append(about.Runtimes, ControlRuntimeState{Name: rt, Found: onPath(rt)})
	}
	return about, nil
}

func controlRootsList(req *controlRequest, u *UI) (any, *controlFailure) {
	ss := LoadStackSet()
	if ss.refuseUnreadable(u) {
		return nil, failed(u, controlCodeUnreadableState)
	}
	known, warning := knownRoots(localStacks(ss))
	out := ControlRootsListResult{Roots: []ControlRoot{}}
	if warning != nil {
		out.Warnings = []string{warning.Error()}
	}
	for _, r := range known {
		out.Roots = append(out.Roots, r.control())
	}
	codespaces, _ := knownCodespaces(codespaceStacks(ss))
	for _, c := range codespaces {
		out.Roots = append(out.Roots, c.control())
	}
	return out, nil
}

// control: r as roots.list states it.
func (r *knownRoot) control() ControlRoot {
	path, present := r.path, !r.missing
	root := ControlRoot{Placement: DiscoveredKBPlacementLocal, Path: &path, Present: &present,
		Current: stated(r.current), Registered: r.entry != nil, Running: r.running,
		Did: stated(r.did), SiteName: stated(r.siteName), Config: stated(r.config)}
	if r.identityErr != nil {
		root.IdentityError = stated(r.identityErr.Error())
	}
	if r.entry != nil && !r.entry.LastUsed.IsZero() {
		root.LastUsed = stated(r.entry.LastUsed.UTC().Format(time.RFC3339))
	}
	if present {
		root.Configs = stack.InferenceNames(r.path)
	}
	return root
}

// control: c as roots.list states it.
func (c knownCodespace) control() ControlRoot {
	cs := c.stack.Codespace
	root := ControlRoot{Placement: DiscoveredKBPlacementCodespace, Running: true,
		Repo: stated(cs.Repo), Codespace: stated(cs.Name), Did: stated(c.stack.KBDid), CodespaceState: stated(c.state)}
	if cs.ForwardPort != 0 {
		port, forwarded, reachable := cs.ForwardPort, c.forwarded, c.reachable
		root.ForwardPort, root.Forwarded, root.Reachable = &port, &forwarded, &reachable
	}
	return root
}

func controlRootsForget(req *controlRequest, u *UI) (any, *controlFailure) {
	var p ControlRootsForgetParams
	if f := req.decode(&p); f != nil {
		return nil, f
	}
	f, ok := forgetRoot(u, p.Root)
	if !ok {
		return nil, failed(u, controlCodeFailed)
	}
	return ControlRootsForgetResult{Path: f.path, DirectoryMissing: f.directoryMissing, PersistentState: stated(f.persistentState)}, nil
}

func controlStatusSnapshot(req *controlRequest, u *UI) (any, *controlFailure) {
	var p ControlStatusSnapshotParams
	if f := req.decode(&p); f != nil {
		return nil, f
	}
	if refuseCodespaceRuntime(u, p.Target, p.Runtime) {
		return nil, failed(u, controlCodeInvalidRequest)
	}
	ss := LoadStackSet()
	if ss.refuseUnreadable(u) {
		return nil, failed(u, controlCodeUnreadableState)
	}
	if p.Target != nil && p.Target.Kind == "codespace" {
		st, ok := repoCodespaceStack(u, ss, *p.Target.Repo)
		if !ok {
			return nil, failed(u, controlCodeFailed)
		}
		return statusSnapshot(ss, nil, kbRoot{}, []*StackState{st}), nil
	}
	root := ""
	if p.Target != nil {
		root = given(p.Target.Root)
	}
	chosen, ok := reportedStacks(u, ss, root)
	if !ok {
		return nil, failed(u, controlCodeFailed)
	}
	views, ok := statusViews(u, chosen, given(p.Runtime))
	if !ok {
		return nil, failed(u, controlCodeRuntimeUnavailable)
	}
	var codespaces []*StackState
	if chosen.every && p.Target == nil {
		codespaces = codespaceStacks(ss)
	}
	return statusSnapshot(ss, views, chosen.cwd, codespaces), nil
}

// refuseCodespaceRuntime refuses a runtime named for a codespace target: a
// codespace's own launcher chooses its runtime.
func refuseCodespaceRuntime(u *UI, target *ControlTarget, runtime *string) bool {
	if target != nil && target.Kind == "codespace" && runtime != nil {
		u.Refuse(controlCodeInvalidRequest, "runtime names a local stack's container runtime, and the target is a codespace's stack, whose own launcher chooses its runtime.")
		return true
	}
	return false
}

// refuseUnknownSelection refuses a service or a group the launcher has none
// of, which semiont start refuses in the same words.
func refuseUnknownSelection(u *UI, service, group *string) bool {
	if service != nil && !knownRole(*service) {
		u.Refuse(controlCodeInvalidService, "Unknown --service '%s' (expected: %s)", *service, roleList)
		return true
	}
	if group != nil {
		if _, known := groupNamed(*group); !known {
			u.Refuse(controlCodeInvalidService, "Unknown --group '%s' (expected: %s)", *group, groupList)
			return true
		}
	}
	return false
}

// targetArgs: the flags that name target, as semiont start and semiont stop
// take them. A codespace target is --repo; start names its platform too.
func targetArgs(target *ControlTarget, platform bool) []string {
	switch {
	case target == nil:
		return nil
	case target.Kind == "codespace" && platform:
		return []string{"--runtime", "codespace", "--repo", *target.Repo}
	case target.Kind == "codespace":
		return []string{"--repo", *target.Repo}
	case target.Root != nil:
		return []string{"--root", *target.Root}
	}
	return nil
}

// valueFlag: a flag that takes a value, and the param that gives it.
type valueFlag struct {
	flag  string
	value *string
}

// valueArgs: each flag whose param is given, and its value.
func valueArgs(flags ...valueFlag) []string {
	var args []string
	for _, f := range flags {
		if f.value != nil {
			args = append(args, f.flag, *f.value)
		}
	}
	return args
}

// startArgs: the command line of the start p asks for, as semiont start reads
// a person's (protocol/specs/src/control/cli.json maps each flag).
func startArgs(p ControlStackStartParams) []string {
	args := targetArgs(p.Target, true)
	args = append(args, valueArgs(
		valueFlag{"--runtime", p.Runtime},
		valueFlag{"--config", p.Config},
		valueFlag{"--service", p.Service},
		valueFlag{"--group", p.Group},
		valueFlag{"--codespace", p.CodespaceName},
		valueFlag{"--machine", p.Machine},
		valueFlag{"--idle-timeout", p.IdleTimeout},
		valueFlag{"--retention-period", p.RetentionPeriod},
		valueFlag{"--ollama-cache", p.OllamaCache},
	)...)
	if p.Observe != nil && !*p.Observe {
		args = append(args, "--no-observe")
	}
	if asked(p.DryRun) {
		args = append(args, "--dry-run")
	}
	return args
}

// stopArgs: the command line of the stop p asks for, as semiont stop reads a
// person's.
func stopArgs(p ControlStackStopParams) []string {
	args := targetArgs(p.Target, false)
	args = append(args, valueArgs(
		valueFlag{"--runtime", p.Runtime},
		valueFlag{"--service", p.Service},
		valueFlag{"--group", p.Group},
	)...)
	if asked(p.Delete) {
		args = append(args, "--delete")
	}
	if asked(p.DryRun) {
		args = append(args, "--dry-run")
	}
	return args
}

func controlStackStart(req *controlRequest, u *UI) (any, *controlFailure) {
	var p ControlStackStartParams
	if f := req.decode(&p); f != nil {
		return nil, f
	}
	if refuseCodespaceRuntime(u, p.Target, p.Runtime) {
		return nil, failed(u, controlCodeInvalidRequest)
	}
	if refuseUnknownSelection(u, p.Service, p.Group) {
		return nil, failed(u, controlCodeInvalidService)
	}
	args := startArgs(p)
	opts, _, _ := parseStart(args)
	code := Start(u, args)
	releaseStartLock()
	if code != 0 {
		return nil, failed(u, controlCodeFailed)
	}
	if opts.dryRun {
		return ControlStackStartResult{DryRun: true}, nil
	}
	return startedStatus(u, opts, p.Target), nil
}

// startedStatus: what status reads after a start of opts: the knowledge base
// it started, when it started one, and the shared services.
func startedStatus(u *UI, opts startOptions, target *ControlTarget) ControlStackStartResult {
	ss := LoadStackSet()
	if opts.platform == platformCodespace {
		out := ControlStackStartResult{Shared: sharedStatuses(nil, ss)}
		if st := codespaceStack(ss, opts.repo); st != nil {
			kb := codespaceStatus(st, true, publishedKBs(ss), LoadTokens())
			out.KnowledgeBase = &kb
		}
		return out
	}
	var started kbRoot
	if opts.readsConfig() {
		started = startedRoot(target)
	}
	if started.dir == "" {
		return ControlStackStartResult{Shared: sharedStatuses(nil, ss)}
	}
	v, code := newStackView(u, localStack(ss, started.key()), started.key(), opts.runtime)
	if code != 0 {
		return ControlStackStartResult{Shared: sharedStatuses(nil, ss)}
	}
	views := []stackView{v}
	nameViews(views)
	snapshot := statusSnapshot(ss, views, started, nil)
	out := ControlStackStartResult{Shared: snapshot.Shared}
	if len(snapshot.KnowledgeBases) == 1 {
		out.KnowledgeBase = &snapshot.KnowledgeBases[0]
	}
	return out
}

// startedRoot: the knowledge base a start of target ran: the root it names,
// else the one the start entered, which its turn still stands in.
func startedRoot(target *ControlTarget) kbRoot {
	if target != nil && target.Root != nil {
		dir, ident, err := resolveRootArg(*target.Root)
		if err != nil {
			return kbRoot{}
		}
		return kbRoot{dir: dir, ident: ident}
	}
	kb, err := cwdKBRoot()
	if err != nil {
		return kbRoot{}
	}
	return kb
}

func controlStackStop(req *controlRequest, u *UI) (any, *controlFailure) {
	var p ControlStackStopParams
	if f := req.decode(&p); f != nil {
		return nil, f
	}
	if refuseCodespaceRuntime(u, p.Target, p.Runtime) {
		return nil, failed(u, controlCodeInvalidRequest)
	}
	switch {
	case asked(p.Delete) && !asked(p.DeleteConfirmed):
		u.Refuse(controlCodeConfirmationRequired, "delete destroys the codespace, state and all: send it with deleteConfirmed once a person has confirmed it.")
		return nil, failed(u, controlCodeConfirmationRequired)
	case asked(p.DeleteConfirmed) && !asked(p.Delete):
		u.Refuse(controlCodeInvalidRequest, "deleteConfirmed confirms a delete, and the request asks for none.")
		return nil, failed(u, controlCodeInvalidRequest)
	}
	if Stop(u, stopArgs(p)) != 0 {
		return nil, failed(u, controlCodeFailed)
	}
	if asked(p.DryRun) {
		return ControlStackStopResult{DryRun: true}, nil
	}
	ss := LoadStackSet()
	var views []stackView
	for _, st := range localStacks(ss) {
		v, code := newStackView(u, st, rootKey(st.KBDid, st.KBRoot), "")
		if code != 0 {
			return nil, failed(u, controlCodeRuntimeUnavailable)
		}
		views = append(views, v)
	}
	nameViews(views)
	snapshot := statusSnapshot(ss, views, kbRoot{}, codespaceStacks(ss))
	return ControlStackStopResult{KnowledgeBases: snapshot.KnowledgeBases, Shared: snapshot.Shared}, nil
}

// verbTarget: the stack a knowledge verb of target and runtime acts on, as
// SelectVerbStack chooses it for the command line's --repo, --root and
// --runtime; nil when none is recorded and none was named. A local target
// keeps to the local stacks, as --runtime does. ok=false: refused, and said.
func verbTarget(u *UI, verb string, target *ControlTarget, runtime *string) (*StackState, bool) {
	repo, root, wantLocal := "", "", runtime != nil
	if target != nil {
		repo, root = given(target.Repo), given(target.Root)
		wantLocal = wantLocal || target.Kind == "local"
	}
	return SelectVerbStack(u, verb, LoadStackSet(), repo, root, wantLocal)
}

func controlAuthLogin(req *controlRequest, u *UI) (any, *controlFailure) {
	var p ControlAuthLoginParams
	if f := req.decode(&p); f != nil {
		return nil, f
	}
	target, ok := verbTarget(u, "login", p.Target, p.Runtime)
	if !ok {
		return nil, failed(u, controlCodeFailed)
	}
	base, ok := StackBase(u, target, "login")
	if !ok {
		return nil, failed(u, controlCodeFailed)
	}
	key := StackKey(target)
	if held, have := LoadTokens()[key]; have && storedTokenState(base, held.Token) == sessionValid {
		u.Refuse(controlCodeAlreadySignedIn, "Already signed in to %s: the gateway accepts the stored session.", key)
		return nil, failed(u, controlCodeAlreadySignedIn)
	}
	signedIn, ok := signIn(req.ctx, u, target, func(code semiont.DeviceCode) {
		action := ControlUserAction{RequestId: req.id, VerificationUri: code.VerificationURI,
			VerificationUriComplete: stated(code.VerificationURIComplete), UserCode: code.UserCode,
			ExpiresInSeconds: int(code.ExpiresIn.Seconds())}
		req.server.notify(req, "notifications/userAction", action)
		u.Log("Waiting for approval at the issuer...")
		// The wait is a person's: the next request takes its turn meanwhile.
		req.endTurn()
	})
	if !ok {
		return nil, failed(u, controlCodeSignInFailed)
	}
	return signedIn, nil
}

func controlAuthLogout(req *controlRequest, u *UI) (any, *controlFailure) {
	var p ControlAuthLogoutParams
	if f := req.decode(&p); f != nil {
		return nil, f
	}
	target, ok := verbTarget(u, "logout", p.Target, p.Runtime)
	if !ok {
		return nil, failed(u, controlCodeFailed)
	}
	ended, ok := signOut(req.ctx, u, target)
	if !ok {
		return nil, failed(u, controlCodeFailed)
	}
	return ended, nil
}

func controlLogsFollow(req *controlRequest, u *UI) (any, *controlFailure) {
	var p ControlLogsFollowParams
	if f := req.decode(&p); f != nil {
		return nil, f
	}
	if refuseCodespaceRuntime(u, p.Target, p.Runtime) {
		return nil, failed(u, controlCodeInvalidRequest)
	}
	repo, root := "", ""
	if p.Target != nil {
		repo, root = given(p.Target.Repo), given(p.Target.Root)
	}
	src, ok := logSources(u, given(p.Runtime), given(p.Service), repo, root)
	if !ok {
		return nil, failed(u, controlCodeFailed)
	}
	// A follow runs until its sources end or it is cancelled: the next
	// request takes its turn meanwhile.
	req.endTurn()
	followLogs(req.ctx, src, func(service, stream, line string) {
		req.server.notify(req, "notifications/log", ControlLogRecord{RequestId: req.id, Service: service, Stream: stream,
			Line: scrubSecrets(line), ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano)})
	})
	return ControlLogsFollowResult{Services: src.follow}, nil
}

func controlSettingsList(req *controlRequest, u *UI) (any, *controlFailure) {
	var p ControlSettingsListParams
	if f := req.decode(&p); f != nil {
		return nil, f
	}
	kb, rootErr, ok := settingsRoot(u, given(p.Root))
	if !ok {
		return nil, failed(u, controlCodeRootNotFound)
	}
	out := ControlSettingsListResult{Settings: []ControlSetting{}}
	if rootErr != nil {
		out.Unresolved = stated(rootErr.Error())
	} else {
		out.Root = stated(kb.dir)
	}
	for _, appliesTo := range []string{appliesToMachine, appliesToKB} {
		if appliesTo == appliesToKB && rootErr != nil {
			continue
		}
		for _, s := range settingsTable {
			if s.appliesTo == appliesTo {
				out.Settings = append(out.Settings, controlSetting(u, s, kb))
			}
		}
	}
	return out, nil
}

// controlSetting: s, in kb, as the control API states a setting.
func controlSetting(u *UI, s setting, kb kbRoot) ControlSetting {
	out := ControlSetting{Name: s.name, Default: s.flag == "--default", AppliesTo: s.appliesTo,
		Values: []ControlSettingLine{}, Settable: s.set != nil}
	for _, l := range s.show(u, kb) {
		out.Values = append(out.Values, ControlSettingLine{Value: l.value, Source: l.source})
	}
	if s.changedBy != nil {
		out.ChangedBy = stated(s.changedBy())
	}
	return out
}

// askedSetting: the setting name names, its machine-wide form when dflt, and
// the knowledge base it is read in, with why none resolved. ok=false:
// refused, and said.
func askedSetting(u *UI, name string, dflt *bool, root *string) (setting, kbRoot, error, bool) {
	flag := ""
	if asked(dflt) {
		flag = "--default"
	}
	rows, ok := settingsNamed(u, name, flag)
	if !ok {
		return setting{}, kbRoot{}, nil, false
	}
	kb, rootErr, ok := settingsRoot(u, given(root))
	if !ok {
		return setting{}, kbRoot{}, nil, false
	}
	return rows[0], kb, rootErr, true
}

func controlSettingsGet(req *controlRequest, u *UI) (any, *controlFailure) {
	var p ControlSettingsGetParams
	if f := req.decode(&p); f != nil {
		return nil, f
	}
	s, kb, rootErr, ok := askedSetting(u, p.Name, p.Default, p.Root)
	if !ok || refuseUnrooted(u, s, rootErr) {
		return nil, failed(u, controlCodeFailed)
	}
	return controlSetting(u, s, kb), nil
}

func controlSettingsSet(req *controlRequest, u *UI) (any, *controlFailure) {
	var p ControlSettingsSetParams
	if f := req.decode(&p); f != nil {
		return nil, f
	}
	s, kb, rootErr, ok := askedSetting(u, p.Name, p.Default, p.Root)
	if !ok {
		return nil, failed(u, controlCodeFailed)
	}
	if !changeSetting(u, s, kb, rootErr, p.Value, false) {
		return nil, failed(u, controlCodeInvalidValue)
	}
	return controlSetting(u, s, kb), nil
}

func controlSettingsUnset(req *controlRequest, u *UI) (any, *controlFailure) {
	var p ControlSettingsUnsetParams
	if f := req.decode(&p); f != nil {
		return nil, f
	}
	s, kb, rootErr, ok := askedSetting(u, p.Name, p.Default, p.Root)
	if !ok {
		return nil, failed(u, controlCodeFailed)
	}
	if !changeSetting(u, s, kb, rootErr, "", true) {
		return nil, failed(u, controlCodeFailed)
	}
	return controlSetting(u, s, kb), nil
}

func controlSettingsPath(req *controlRequest, u *UI) (any, *controlFailure) {
	var p ControlSettingsPathParams
	if f := req.decode(&p); f != nil {
		return nil, f
	}
	path, ok := machineDocuments[p.Document](u)
	if !ok {
		return nil, failed(u, controlCodeFailed)
	}
	return ControlSettingsPathResult{Path: path}, nil
}
