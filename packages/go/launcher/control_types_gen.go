// Code generated from protocol/specs/src/control/methods.json and the schemas it names — DO NOT EDIT.
//
// Regenerate: node packages/codegen/schemas/generate-control.mjs

package launcher

import "encoding/json"

// ControlAboutParams: launcher.about's params.
type ControlAboutParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`
}

// ControlAboutResult: What the launcher is. A client asks this first, to
// learn whether it speaks to the launcher it found.
type ControlAboutResult struct {
	// The version stamped into the launcher at build. Absent from a development
	// build, which states none.
	Version *string `json:"version,omitempty"`

	// Whether this is a development build: one with no version stamped.
	Development bool `json:"development"`

	// The commit it was built from, when stamped.
	Commit *string `json:"commit,omitempty"`

	// When it was built, when stamped.
	Built *string `json:"built,omitempty"`

	// Each version of the control API it speaks. A client that speaks none of
	// them stops here.
	ApiVersions []string `json:"apiVersions"`

	// The registry its catalog's images come from.
	ImageRegistry string `json:"imageRegistry"`

	// Each container runtime it drives, in the order it prefers them, and
	// whether this machine has it.
	Runtimes []ControlRuntimeState `json:"runtimes"`
}

// ControlRuntimeState: One container runtime the launcher drives, and whether
// this machine has it.
type ControlRuntimeState struct {
	// A container runtime the launcher drives, as --runtime names it: Apple
	// container, Docker or Podman.
	Name string `json:"name"`

	// Whether it is on the launcher's PATH.
	Found bool `json:"found"`
}

// ControlRootsListParams: roots.list's params.
type ControlRootsListParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`
}

// ControlRootsListResult: Every knowledge base this machine knows, as semiont
// roots lists them: the local roots first, then the codespace stacks.
type ControlRootsListResult struct {
	// Each root.
	Roots []ControlRoot `json:"roots"`

	// What semiont roots warns of without failing: an invalid SEMIONT_ROOT, a
	// clone whose project file is refused.
	Warnings []string `json:"warnings,omitempty"`
}

// ControlRoot: One knowledge base this machine knows: a registered or running
// local clone, or a codespace stack recorded here. Registration, the
// directory, the stack and the forward are separate facts, each stated as it
// is.
type ControlRoot struct {
	// Where the stack actually runs. "local": containers on this machine.
	// "codespace": a GitHub-hosted VM whose KB is port-forwarded here.
	Placement DiscoveredKBPlacement `json:"placement"`

	// For a local root: the clone's path.
	Path *string `json:"path,omitempty"`

	// For a local root: whether the directory exists. A registered root whose
	// directory is gone is kept, and says so.
	Present *bool `json:"present,omitempty"`

	// For a local root: how the control server's own directory selects it, when
	// it does — standing in it (cwd), or SEMIONT_ROOT.
	Current *string `json:"current,omitempty"`

	// Whether the registry (roots.json) records it.
	Registered bool `json:"registered"`

	// Whether a stack of it is recorded on this machine.
	Running bool `json:"running"`

	// When a command last used it, in RFC 3339, as the registry records it.
	LastUsed *string `json:"lastUsed,omitempty"`

	// The KB's did:web identifier, from its committed .semiont/config.yaml —
	// "did:web:" + its site.domain, verbatim. REQUIRED: a KB that declares no
	// domain has no identity to publish, and the launcher refuses to start it
	// rather than inventing or defaulting one. NOT unique within a document: a
	// did names the knowledge base, not a running copy of it, so a local clone
	// and a codespace of the same repo legitimately share one and both are
	// published. host:port is the unique field (at most one entry per address),
	// so consumers look up by ADDRESS and use the did to VERIFY that the copy
	// they reached is the KB they meant — an address alone cannot say which KB
	// is which, and an identity alone cannot say which copy.
	Did *string `json:"did,omitempty"`

	// Human-readable site name from the KB's .semiont/config.yaml
	// (site.siteName), for display
	SiteName *string `json:"siteName,omitempty"`

	// Why its identity could not be read from its clone, when it could not.
	IdentityError *string `json:"identityError,omitempty"`

	// The Inference document a start of it runs, as the registry records it.
	Config *string `json:"config,omitempty"`

	// For a present local root: the Inference documents its clone has, as start
	// --config names them.
	Configs []string `json:"configs,omitempty"`

	// owner/name GitHub slug — present for codespace placements, where the repo
	// is the stack's identity
	Repo *string `json:"repo,omitempty"`

	// For a codespace root: the codespace's name.
	Codespace *string `json:"codespace,omitempty"`

	// For a codespace root: GitHub's word for the codespace's state (Available,
	// Shutdown), when gh answered.
	CodespaceState *string `json:"codespaceState,omitempty"`

	// For a codespace root: the port on this machine its knowledge base is
	// forwarded to, when one is recorded.
	ForwardPort *int `json:"forwardPort,omitempty"`

	// For a codespace root: whether the recorded forward is alive.
	Forwarded *bool `json:"forwarded,omitempty"`

	// For a codespace root: whether its knowledge base answers through the
	// forward.
	Reachable *bool `json:"reachable,omitempty"`
}

// ControlRootsInitParams: roots.init's params: the local directory, permanent
// identity, and optional configuration inputs semiont init takes.
type ControlRootsInitParams struct {
	// The group and version of the control API. Every request's params state it;
	// a launcher refuses a version it does not speak with
	// control.unsupported-api-version, and names the ones it does.
	ApiVersion string `json:"apiVersion"`

	// Existing local directory in which to create the knowledge base.
	Path string `json:"path"`

	// The permanent did:web domain, in colon-path form, such as
	// owner.github.io:repo.
	Domain string `json:"domain"`

	// Project name. Absent: the directory basename.
	Name *string `json:"name,omitempty"`

	// Human-readable site name. Absent: the project name.
	SiteName *string `json:"siteName,omitempty"`

	// Inference provider for the generated local stack documents.
	Inference *string `json:"inference,omitempty"`

	// The primary model bound to roles and jobs.
	Model *string `json:"model,omitempty"`

	// A light model example emitted in the generated config.
	ModelLight *string `json:"modelLight,omitempty"`

	// Ollama embedding model name, without the ollama: prefix.
	Embedding *string `json:"embedding,omitempty"`

	// Inference document name. Absent: the provider name.
	ConfigName *string `json:"configName,omitempty"`

	// Anthropic API base URL.
	AnthropicEndpoint *string `json:"anthropicEndpoint,omitempty"`

	// Local Ollama API base URL.
	OllamaBase *string `json:"ollamaBase,omitempty"`

	// Ollama registry base URL.
	OllamaRegistry *string `json:"ollamaRegistry,omitempty"`
}

// ControlRootsInitResult: The local directory where semiont init created and
// registered the knowledge base.
type ControlRootsInitResult struct {
	Path string `json:"path"`
}

// ControlRootsForgetParams: roots.forget's params.
type ControlRootsForgetParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`

	// The registered root to forget: its path, or its basename when only one
	// registered root has it.
	Root string `json:"root"`
}

// ControlRootsForgetResult: A forgotten registry row. Only the row is
// removed: no file of the clone, and none of its persistent stack state.
type ControlRootsForgetResult struct {
	// The forgotten root's path.
	Path string `json:"path"`

	// Whether its directory was already gone.
	DirectoryMissing bool `json:"directoryMissing"`

	// The key whose persistent stack state remains, when some does and no
	// surviving root shares its DID: semiont clean --root <key> removes it.
	PersistentState *string `json:"persistentState,omitempty"`
}

// ControlStatusSnapshotParams: status.snapshot's params.
type ControlStatusSnapshotParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`

	// Which knowledge base's stack. Absent: the one the command line chooses,
	// standing where the control server was started.
	Target *ControlTarget `json:"target,omitempty"`

	// The container runtime to ask, as --runtime names it. Absent: the one the
	// stack's record names, else every installed one.
	Runtime *string `json:"runtime,omitempty"`
}

// ControlTarget: Which knowledge base an operation acts on: a local clone's
// stack, or a codespace's. The launcher resolves it as the command line
// resolves --root and --repo, and refuses a choice it would have to guess.
type ControlTarget struct {
	// Where the stack runs: on this machine (local), or on a GitHub codespace
	// whose knowledge base is forwarded here (codespace).
	Kind string `json:"kind"`

	// For a local target: the knowledge base's clone, by path or by the basename
	// of a registered root, as --root takes it. Absent: the local stack the
	// command line chooses with --runtime, standing where the control server was
	// started.
	Root *string `json:"root,omitempty"`

	// For a codespace target: the GitHub repository, as --repo takes it.
	Repo *string `json:"repo,omitempty"`
}

// ControlStatusSnapshotResult: What semiont status reports: each knowledge
// base with its own services, and each service the knowledge bases share,
// once, with the knowledge bases it serves.
type ControlStatusSnapshotResult struct {
	// The target's stack; with no target, the stack of the knowledge base the
	// control server stands in, else every recorded one.
	KnowledgeBases []ControlKnowledgeBaseStatus `json:"knowledgeBases"`

	// The services every knowledge base shares, group by group, and those the
	// machine serves for the knowledge bases that name them.
	Shared []ControlServiceStatus `json:"shared"`
}

// ControlKnowledgeBaseStatus: One knowledge base's stack as semiont status
// reads it: what it is, where it runs, and each of its own services. The
// services every knowledge base shares are reported once, in the snapshot's
// shared list.
type ControlKnowledgeBaseStatus struct {
	// What the snapshot calls the knowledge base: the last segment of its DID,
	// or the whole DID where two would share one, or its key.
	Name string `json:"name"`

	// The knowledge base's key on this machine, which names its containers and
	// its state.
	Key string `json:"key"`

	// Whether a stack of it is recorded. When none is, its services are found by
	// name.
	Recorded bool `json:"recorded"`

	// Where the stack actually runs. "local": containers on this machine.
	// "codespace": a GitHub-hosted VM whose KB is port-forwarded here.
	Placement DiscoveredKBPlacement `json:"placement"`

	// Its clone, for a local stack.
	Root *string `json:"root,omitempty"`

	// owner/name GitHub slug — present for codespace placements, where the repo
	// is the stack's identity
	Repo *string `json:"repo,omitempty"`

	// The KB's did:web identifier, from its committed .semiont/config.yaml —
	// "did:web:" + its site.domain, verbatim. REQUIRED: a KB that declares no
	// domain has no identity to publish, and the launcher refuses to start it
	// rather than inventing or defaulting one. NOT unique within a document: a
	// did names the knowledge base, not a running copy of it, so a local clone
	// and a codespace of the same repo legitimately share one and both are
	// published. host:port is the unique field (at most one entry per address),
	// so consumers look up by ADDRESS and use the did to VERIFY that the copy
	// they reached is the KB they meant — an address alone cannot say which KB
	// is which, and an identity alone cannot say which copy.
	Did *string `json:"did,omitempty"`

	// Human-readable site name from the KB's .semiont/config.yaml
	// (site.siteName), for display
	SiteName *string `json:"siteName,omitempty"`

	// Why its identity could not be read from its clone, when it could not.
	IdentityError *string `json:"identityError,omitempty"`

	// The knowledge base as the discovery document publishes it, when it does.
	Kb *DiscoveredKB `json:"kb,omitempty"`

	// The runtime its record names.
	Runtime *string `json:"runtime,omitempty"`

	// The base URL of its gateway, from its record.
	Gateway *string `json:"gateway,omitempty"`

	// Where the values the launcher generates for it are kept, as semiont
	// settings secret-store describes it.
	SecretStore *string `json:"secretStore,omitempty"`

	// This machine's address on the network, when the stack is started with
	// network lan.
	Lan *string `json:"lan,omitempty"`

	// Whether a semiont start of it holds its start lock: its services are not
	// ready, whatever they report.
	Starting bool `json:"starting"`

	// The launcher's own stored sign-in for a stack (semiont login), never
	// Desktop's. No token is in it.
	Session *ControlSession `json:"session,omitempty"`

	// Whether each of its counted services, and the issuer it signs in at,
	// answers.
	Healthy bool `json:"healthy"`

	// Its own services, group by group, then the issuer it signs in at. Empty
	// for a codespace's, whose services its own launcher reports.
	Services []ControlServiceStatus `json:"services"`

	// The ledger and job queue readings the launcher can attribute to this
	// knowledge base. A missing reading means the Collector has not reported
	// that metric, not that its value is zero.
	Workload *ControlWorkloadStatus `json:"workload,omitempty"`
}

// ControlSession: The launcher's own stored sign-in for a stack (semiont
// login), never Desktop's. No token is in it.
type ControlSession struct {
	// valid: the stack's gateway accepts the stored token. expired: it refuses
	// it (a refresh, or semiont login, renews it). unverified: the stack did not
	// answer. none: nothing is stored.
	State string `json:"state"`

	// The email the session was signed in as, when the store records one.
	Email *string `json:"email,omitempty"`
}

// ControlServiceStatus: One service, as semiont status reads it: where it
// runs, its state, and whether it answers. Nothing is reported that the
// launcher did not observe: an endpoint is named only when the stack's record
// or the descriptor names one, and a page to open only when the service
// answers.
type ControlServiceStatus struct {
	// The service, as semiont status names it.
	Role string `json:"role"`

	// The group it belongs to.
	Group string `json:"group"`

	// The product its driver names (Neo4j, Keycloak), when its record names a
	// driver.
	Product *string `json:"product,omitempty"`

	// Where it runs: the runtime its container runs under, external (somebody
	// else runs it), or host (a process on this machine). Absent when nothing
	// runs it.
	RunsOn *string `json:"runsOn,omitempty"`

	// running: its container runs. stopped: its container exists and does not
	// run (containerState says how). reachable, unreachable: somebody else runs
	// it, and its endpoint answers or does not. absent: there is no container of
	// it. not-configured: the stack's documents ask for none.
	State string `json:"state"`

	// The runtime's own word for a container that is not running (exited,
	// created).
	ContainerState *string `json:"containerState,omitempty"`

	// Whether its health endpoint answers.
	Healthy bool `json:"healthy"`

	// Whether its health counts toward its knowledge base's: a service the
	// documents ask for none of, and a telemetry backend --no-observe leaves
	// out, do not.
	Counted bool `json:"counted"`

	// The endpoint the launcher asks its health of: an http URL, or
	// tcp://host:port.
	Probe *string `json:"probe,omitempty"`

	// The page a person opens: the Browser, Jaeger's and Prometheus's
	// interfaces, the collector's metrics readout. Present only when the service
	// answers. The collector's OTLP receiver is never one.
	Page *string `json:"page,omitempty"`

	// For the issuer the knowledge base signs in at, when it is the machine's:
	// its realm there.
	Realm *string `json:"realm,omitempty"`

	// For a service several knowledge bases share: the name of each it serves,
	// as knowledgeBases names them.
	Serves []string `json:"serves,omitempty"`
}

// ControlWorkloadStatus: A knowledge base's operational readings from
// Collector metrics. Request-tracking occupancy and queue depth are current
// gauges; completed and failed are worker counters since that worker process
// started. Missing readings are unknown, never zero.
type ControlWorkloadStatus struct {
	// The Gateway's request tracking: correlation IDs it currently holds so
	// replies can be routed to the app client that sent each request, and the
	// tracking capacity.
	Ledger *ControlWorkloadStatusLedger `json:"ledger,omitempty"`

	// Current Dispatcher depth and, when the worker has emitted counters,
	// completed and failed work since worker start. These are different
	// measurements and time windows.
	Queue *ControlWorkloadStatusQueue `json:"queue,omitempty"`
}

// ControlWorkloadStatusLedger: The Gateway's request tracking: correlation
// IDs it currently holds so replies can be routed to the app client that sent
// each request, and the tracking capacity.
type ControlWorkloadStatusLedger struct {
	// Number of request IDs currently held to route replies to their requesting
	// app clients. Includes requests still waiting for a reply and recently
	// answered requests still within the tracking window.
	Claims int `json:"claims"`

	// The maximum number of IDs held in this Gateway's local tracking
	// projection.
	Capacity int `json:"capacity"`
}

// ControlWorkloadStatusQueue: Current Dispatcher depth and, when the worker
// has emitted counters, completed and failed work since worker start. These
// are different measurements and time windows.
type ControlWorkloadStatusQueue struct {
	// Jobs currently waiting for a worker.
	Pending int `json:"pending"`

	// Jobs currently claimed by workers.
	Running int `json:"running"`

	// Jobs completed since worker start.
	Completed *int `json:"completed,omitempty"`

	// Jobs finally failed since worker start.
	Failed *int `json:"failed,omitempty"`
}

// ControlStackStartParams: stack.start's params: what semiont start takes,
// but its help and its narration switches.
type ControlStackStartParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`

	// Which knowledge base's stack. Absent: the one the command line chooses,
	// standing where the control server was started.
	Target *ControlTarget `json:"target,omitempty"`

	// The container runtime to ask, as --runtime names it. Absent: the one the
	// stack's record names, else every installed one.
	Runtime *string `json:"runtime,omitempty"`

	// The Inference document to run, as --config names it. Absent: the knowledge
	// base's recorded preference, else the default.
	Config *string `json:"config,omitempty"`

	// Just this one service, as --service names it.
	Service *string `json:"service,omitempty"`

	// Just this one group of services, as --group names it.
	Group *string `json:"group,omitempty"`

	// For a codespace target: which of the repository's codespaces, as
	// --codespace names it.
	CodespaceName *string `json:"codespaceName,omitempty"`

	// For a codespace target being created: its VM class, as --machine names it.
	Machine *string `json:"machine,omitempty"`

	// For a codespace target being created: inactivity before it stops, as
	// --idle-timeout takes it.
	IdleTimeout *string `json:"idleTimeout,omitempty"`

	// For a codespace target being created: how long a stopped codespace is
	// kept, as --retention-period takes it.
	RetentionPeriod *string `json:"retentionPeriod,omitempty"`

	// Whether to start the telemetry backends, Jaeger and Prometheus. false is
	// --no-observe. Absent: true.
	Observe *bool `json:"observe,omitempty"`

	// Where a started Ollama keeps its models, as --ollama-cache names it.
	// Absent: the host's ~/.ollama when there is one, else the named volume —
	// what the command line's prompt does when nobody answers it.
	OllamaCache *string `json:"ollamaCache,omitempty"`

	// Whether to run nothing, and report each runtime command a start would run
	// as a command progress line.
	DryRun *bool `json:"dryRun,omitempty"`
}

// ControlStackStartResult: A start that ran to its end: the stack as status
// reads it afterwards. A start that failed is an error, whatever it started
// before it did; its progress lines say what it did.
type ControlStackStartResult struct {
	// Whether the start ran nothing.
	DryRun bool `json:"dryRun"`

	// The started knowledge base's stack, as status reads it after the start.
	// Absent from a dry run, and from a start of services no knowledge base
	// owns.
	KnowledgeBase *ControlKnowledgeBaseStatus `json:"knowledgeBase,omitempty"`

	// The shared services, as status reads them after the start. Absent from a
	// dry run.
	Shared []ControlServiceStatus `json:"shared,omitempty"`
}

// ControlStackStopParams: stack.stop's params: what semiont stop takes, but
// its help.
type ControlStackStopParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`

	// Which knowledge base's stack. Absent: the one the command line chooses,
	// standing where the control server was started.
	Target *ControlTarget `json:"target,omitempty"`

	// The container runtime to ask, as --runtime names it. Absent: the one the
	// stack's record names, else every installed one.
	Runtime *string `json:"runtime,omitempty"`

	// Just this one service, as --service names it.
	Service *string `json:"service,omitempty"`

	// Just this one group of services, as --group names it.
	Group *string `json:"group,omitempty"`

	// For a codespace target: destroy the codespace, state and all, and forget
	// its record. The command line's --delete. Refused without deleteConfirmed.
	Delete *bool `json:"delete,omitempty"`

	// That the person confirmed the deletion: delete is refused with
	// control.confirmation-required without it.
	DeleteConfirmed *bool `json:"deleteConfirmed,omitempty"`

	// Whether to stop nothing, and report each runtime command a stop would run
	// as a command progress line.
	DryRun *bool `json:"dryRun,omitempty"`
}

// ControlStackStopResult: A stop that ran to its end: what status reads
// afterwards. A stop that failed is an error.
type ControlStackStopResult struct {
	// Whether the stop stopped nothing.
	DryRun bool `json:"dryRun"`

	// The knowledge bases still recorded, as status reads them after the stop.
	// Absent from a dry run.
	KnowledgeBases []ControlKnowledgeBaseStatus `json:"knowledgeBases,omitempty"`

	// The shared services, as status reads them after the stop. Absent from a
	// dry run.
	Shared []ControlServiceStatus `json:"shared,omitempty"`
}

// ControlAuthLoginParams: auth.login's params.
type ControlAuthLoginParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`

	// Which knowledge base's stack. Absent: the one the command line chooses,
	// standing where the control server was started.
	Target *ControlTarget `json:"target,omitempty"`

	// Keep to the local stacks, as --runtime does.
	Runtime *string `json:"runtime,omitempty"`
}

// ControlAuthLoginResult: A completed sign-in, kept in the launcher's sign-in
// store. No token is in it.
type ControlAuthLoginResult struct {
	// The stack's key in the sign-in store.
	Key string `json:"key"`

	// Who the gateway says is signed in: their email, else their DID.
	Who string `json:"who"`

	// The issuer the knowledge base named, where the person signed in.
	Issuer string `json:"issuer"`
}

// ControlAuthLogoutParams: auth.logout's params.
type ControlAuthLogoutParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`

	// Which knowledge base's stack. Absent: the one the command line chooses,
	// standing where the control server was started.
	Target *ControlTarget `json:"target,omitempty"`

	// Keep to the local stacks, as --runtime does.
	Runtime *string `json:"runtime,omitempty"`
}

// ControlAuthLogoutResult: The launcher's session for a stack, ended.
// Desktop's own session is not touched.
type ControlAuthLogoutResult struct {
	// The stack's key in the sign-in store. Absent when no stack is recorded.
	Key *string `json:"key,omitempty"`

	// Whether a session was stored. false: nothing was done.
	WasSignedIn bool `json:"wasSignedIn"`

	// Whether the issuer revoked the session's refresh token. false with
	// wasSignedIn: the local token is forgotten, and the refresh token stays
	// valid at the issuer until it expires.
	Revoked bool `json:"revoked"`
}

// ControlIdentityUseraddParams: Create one account in the launcher-managed
// Keycloak realm for a specific local knowledge base.
type ControlIdentityUseraddParams struct {
	// The group and version of the control API. Every request's params state it;
	// a launcher refuses a version it does not speak with
	// control.unsupported-api-version, and names the ones it does.
	ApiVersion string `json:"apiVersion"`

	// The local knowledge base whose launcher-managed identity realm an
	// operation addresses.
	Target ControlIdentityLocalTarget `json:"target"`

	// The email address that will sign in to this knowledge base.
	Email string `json:"email"`

	// The user's password. Secret: carried only in this local control request,
	// never in progress, diagnostics, or persistent state.
	Password *string `json:"password,omitempty"`

	// Generate a random password in the launcher and return it once in the
	// result.
	GeneratePassword bool `json:"generatePassword"`
}

// ControlIdentityLocalTarget: The local knowledge base whose launcher-managed
// identity realm an operation addresses.
type ControlIdentityLocalTarget struct {
	// Identity administration here is limited to local stacks.
	Kind string `json:"kind"`

	// The selected knowledge base's clone path.
	Root string `json:"root"`
}

// ControlIdentityUseraddResult: The created account's sign-in identity. A
// generated password is present only in this one answer and is not stored by
// the launcher.
type ControlIdentityUseraddResult struct {
	// The account's email address.
	Email string `json:"email"`

	// The identity the account acts under in Semiont.
	Identity string `json:"identity"`

	// Whether a new account was created.
	Created bool `json:"created"`

	// The generated password, returned once so the operator can share it with
	// the user. Absent when the operator supplied the password.
	GeneratedPassword *string `json:"generatedPassword,omitempty"`
}

// ControlIdentityUsersListParams: List accounts in one local knowledge base's
// launcher-managed Keycloak realm.
type ControlIdentityUsersListParams struct {
	// The group and version of the control API. Every request's params state it;
	// a launcher refuses a version it does not speak with
	// control.unsupported-api-version, and names the ones it does.
	ApiVersion string `json:"apiVersion"`

	// The local knowledge base whose launcher-managed identity realm an
	// operation addresses.
	Target ControlIdentityLocalTarget `json:"target"`
}

// ControlIdentityUsersListResult: Accounts in the selected knowledge base's
// launcher-managed identity realm.
type ControlIdentityUsersListResult struct {
	// Accounts, sorted by sign-in name.
	Users []ControlIdentityUser `json:"users"`
}

// ControlIdentityUser: An account in a knowledge base's launcher-managed
// identity realm. Passwords and tokens are never included.
type ControlIdentityUser struct {
	// The account's sign-in name, normally its email address.
	Email string `json:"email"`

	// The identity the account acts under in Semiont.
	Identity string `json:"identity"`

	// Whether the identity provider currently allows this account to sign in.
	Enabled bool `json:"enabled"`
}

// ControlLogsFollowParams: logs.follow's params.
type ControlLogsFollowParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`

	// Which knowledge base's stack. Absent: the one the command line chooses,
	// standing where the control server was started.
	Target *ControlTarget `json:"target,omitempty"`

	// Keep to the local stacks, as --runtime does.
	Runtime *string `json:"runtime,omitempty"`

	// Just this service's container, as --service names it. Absent: each Semiont
	// service the stack runs.
	Service *string `json:"service,omitempty"`
}

// ControlLogsFollowResult: A follow whose every source ended on its own. A
// follow the client cancels is answered with control.cancelled.
type ControlLogsFollowResult struct {
	// The services that were followed.
	Services []string `json:"services"`
}

// ControlSettingsListParams: settings.list's params.
type ControlSettingsListParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`

	// A knowledge base's clone, by path or by the basename of a registered root,
	// as --root takes it. Absent: the clone the control server was started in.
	Root *string `json:"root,omitempty"`
}

// ControlSettingsListResult: Every setting the launcher keeps: the machine's,
// then the knowledge base's.
type ControlSettingsListResult struct {
	// The knowledge base whose settings are listed, when one resolved.
	Root *string `json:"root,omitempty"`

	// Why no knowledge base resolved, when none did: its settings are not
	// listed.
	Unresolved *string `json:"unresolved,omitempty"`

	// Each setting.
	Settings []ControlSetting `json:"settings"`
}

// ControlSetting: One setting the launcher keeps, as semiont settings shows
// it.
type ControlSetting struct {
	// Its name, as semiont settings takes it.
	Name string `json:"name"`

	// Whether this is the machine-wide form of a knowledge-base setting
	// (secret-store --default).
	Default bool `json:"default"`

	// What it applies to: every knowledge base on this machine, or one.
	AppliesTo string `json:"appliesTo"`

	// The values in effect, one per line semiont settings shows.
	Values []ControlSettingLine `json:"values"`

	// Whether settings.set and settings.unset change it.
	Settable bool `json:"settable"`

	// For one they do not: how it is changed instead.
	ChangedBy *string `json:"changedBy,omitempty"`
}

// ControlSettingLine: One value of a setting, and where it came from, as
// semiont settings shows it. A secret's value is never one: a secret setting
// shows where the value is kept.
type ControlSettingLine struct {
	// The value in effect.
	Value string `json:"value"`

	// Where it came from: a record, a document, the default.
	Source string `json:"source"`
}

// ControlSettingsGetParams: settings.get's params.
type ControlSettingsGetParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`

	// The setting, as semiont settings names it.
	Name string `json:"name"`

	// The machine-wide form of a knowledge-base setting: --default.
	Default *bool `json:"default,omitempty"`

	// A knowledge base's clone, by path or by the basename of a registered root,
	// as --root takes it. Absent: the clone the control server was started in.
	Root *string `json:"root,omitempty"`
}

// ControlSettingsSetParams: settings.set's params.
type ControlSettingsSetParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`

	// The setting, as semiont settings names it.
	Name string `json:"name"`

	// The machine-wide form of a knowledge-base setting: --default.
	Default *bool `json:"default,omitempty"`

	// A knowledge base's clone, by path or by the basename of a registered root,
	// as --root takes it. Absent: the clone the control server was started in.
	Root *string `json:"root,omitempty"`

	// The value, checked as a start would check it.
	Value string `json:"value"`
}

// ControlSettingsUnsetParams: settings.unset's params.
type ControlSettingsUnsetParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`

	// The setting, as semiont settings names it.
	Name string `json:"name"`

	// The machine-wide form of a knowledge-base setting: --default.
	Default *bool `json:"default,omitempty"`

	// A knowledge base's clone, by path or by the basename of a registered root,
	// as --root takes it. Absent: the clone the control server was started in.
	Root *string `json:"root,omitempty"`
}

// ControlSettingsPathParams: settings.path's params.
type ControlSettingsPathParams struct {
	// The version of the control API the request is written to.
	ApiVersion string `json:"apiVersion"`

	// Whose document: the Browser's, the worker's, the issuer's or the vector
	// store's.
	Document string `json:"document"`
}

// ControlSettingsPathResult: Where a machine document is. When there is none,
// it is written from the launcher's catalog first, as a start writes it; one
// that does not hold is refused, as a start refuses it.
type ControlSettingsPathResult struct {
	// The document's path.
	Path string `json:"path"`
}

// ControlProgress: One line of what an operation is doing, as the command
// line would tell a person, without colour. A secret value the launcher
// generated or read never appears in one.
type ControlProgress struct {
	// The request a notification is about: the JSON-RPC id its client gave it,
	// as the client gave it.
	RequestId json.RawMessage `json:"requestId"`

	// What the line is: narration (log, note), an outcome (ok, warn, fail), a
	// heading (banner, section), a timestamp (stamp), a runtime command about to
	// run (command), or text the operation printed (output).
	Kind string `json:"kind"`

	// The line.
	Text string `json:"text"`
}

// ControlUserAction: A sign-in waits for a person: open the verification page
// and enter the code. The code is sent here and nowhere else — in no progress
// line, no log record and no diagnostic.
type ControlUserAction struct {
	// The request a notification is about: the JSON-RPC id its client gave it,
	// as the client gave it.
	RequestId json.RawMessage `json:"requestId"`

	// The page where the person enters the code.
	VerificationUri string `json:"verificationUri"`

	// The page with the code already in it, when the issuer offers one.
	VerificationUriComplete *string `json:"verificationUriComplete,omitempty"`

	// The code the person enters.
	UserCode string `json:"userCode"`

	// How long the code is good for, from when it was issued.
	ExpiresInSeconds int `json:"expiresInSeconds"`
}

// ControlLogRecord: One line one of a stack's services wrote. The launcher
// removes from it each secret value the launcher generated or read; anything
// else the service wrote is the client's to handle. The launcher keeps no
// copy.
type ControlLogRecord struct {
	// The request a notification is about: the JSON-RPC id its client gave it,
	// as the client gave it.
	RequestId json.RawMessage `json:"requestId"`

	// The role whose container wrote the line, as semiont status names it.
	Service string `json:"service"`

	// Which of the container's streams the line was on.
	Stream string `json:"stream"`

	// The line, without its newline.
	Line string `json:"line"`

	// When the launcher read the line, in RFC 3339 with its fraction: a
	// container's own lines carry the time it wrote them, if any.
	ReceivedAt string `json:"receivedAt"`
}

// ControlCancelled: The client gives up on one of its requests. The launcher
// answers that request with control.cancelled, unless it has answered it
// already; a cancellation of a request it does not know is ignored.
type ControlCancelled struct {
	// The request a notification is about: the JSON-RPC id its client gave it,
	// as the client gave it.
	RequestId json.RawMessage `json:"requestId"`

	// Why, for the launcher's diagnostics.
	Reason *string `json:"reason,omitempty"`
}

// ControlErrorData: The data of a control error: the launcher's code for the
// failure, one of protocol/specs/src/errors/codes.json's control group, and
// what a client can act on. A request's failure is never only a message.
type ControlErrorData struct {
	// Why the request failed: a code of the control group of
	// protocol/specs/src/errors/codes.json.
	Code string `json:"code"`

	// Whether the same request can succeed sent again unchanged, once something
	// outside it changes: a start finishes, a runtime is installed, a stack
	// comes up.
	Retryable bool `json:"retryable"`

	// For params the contract refuses: each fault, where it is.
	Fields []ControlFieldFault `json:"fields,omitempty"`

	// For control.target-required and control.target-ambiguous: each target the
	// request could have meant, to send again with one.
	Choices []ControlTarget `json:"choices,omitempty"`

	// For control.unsupported-api-version: each version this launcher speaks.
	Supported []string `json:"supported,omitempty"`

	// For a cancelled stack.start: whether services the start launched may still
	// be running. The launcher stops waiting, and stops nothing.
	MayStillRun *bool `json:"mayStillRun,omitempty"`
}

// ControlFieldFault: One fault in a request's params, named where it is.
type ControlFieldFault struct {
	// Where in the params the fault is, as a JSON pointer (RFC 6901); empty for
	// the params as a whole.
	Field string `json:"field"`

	// What is wrong there.
	Message string `json:"message"`
}
