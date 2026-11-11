// Code generated from protocol/specs/src/control/methods.json and the schemas it names — DO NOT EDIT.
//
// Regenerate: node packages/codegen/schemas/generate-control.mjs

import type { DiscoveredKB } from '@semiont/core';

/** The version of the control API this client speaks. */
export const CONTROL_API_VERSION = "control.semiont.the-ai-alliance.github.io/v1alpha1";

/** launcher.about's params. */
export interface ControlAboutParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
}

/** The group and version of the control API. Every request's params state it; a launcher refuses a version it does not speak with control.unsupported-api-version, and names the ones it does. */
export type ControlApiVersion = "control.semiont.the-ai-alliance.github.io/v1alpha1";

/** What the launcher is. A client asks this first, to learn whether it speaks to the launcher it found. */
export interface ControlAboutResult {
  /** The version stamped into the launcher at build. Absent from a development build, which states none. */
  version?: string;
  /** Whether this is a development build: one with no version stamped. */
  development: boolean;
  /** The commit it was built from, when stamped. */
  commit?: string;
  /** When it was built, when stamped. */
  built?: string;
  /** Each version of the control API it speaks. A client that speaks none of them stops here. */
  apiVersions: string[];
  /** The registry its catalog's images come from. */
  imageRegistry: string;
  /** Each container runtime it drives, in the order it prefers them, and whether this machine has it. */
  runtimes: ControlRuntimeState[];
}

/** One container runtime the launcher drives, and whether this machine has it. */
export interface ControlRuntimeState {
  /** A container runtime the launcher drives, as --runtime names it: Apple container, Docker or Podman. */
  name: ControlRuntime;
  /** Whether it is on the launcher's PATH. */
  found: boolean;
}

/** A container runtime the launcher drives, as --runtime names it: Apple container, Docker or Podman. */
export type ControlRuntime = "container" | "docker" | "podman";

/** roots.list's params. */
export interface ControlRootsListParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
}

/** Every knowledge base this machine knows, as semiont roots lists them: the local roots first, then the codespace stacks. */
export interface ControlRootsListResult {
  /** Each root. */
  roots: ControlRoot[];
  /** What semiont roots warns of without failing: an invalid SEMIONT_ROOT, a clone whose project file is refused. */
  warnings?: string[];
}

/** One knowledge base this machine knows: a registered or running local clone, or a codespace stack recorded here. Registration, the directory, the stack and the forward are separate facts, each stated as it is. */
export interface ControlRoot {
  /** Where the stack actually runs. "local": containers on this machine. "codespace": a GitHub-hosted VM whose KB is port-forwarded here. */
  placement: NonNullable<DiscoveredKB['placement']>;
  /** For a local root: the clone's path. */
  path?: string;
  /** For a local root: whether the directory exists. A registered root whose directory is gone is kept, and says so. */
  present?: boolean;
  /** For a local root: how the control server's own directory selects it, when it does — standing in it (cwd), or SEMIONT_ROOT. */
  current?: "cwd" | "semiont-root";
  /** Whether the registry (roots.json) records it. */
  registered: boolean;
  /** Whether a stack of it is recorded on this machine. */
  running: boolean;
  /** When a command last used it, in RFC 3339, as the registry records it. */
  lastUsed?: string;
  /** The KB's did:web identifier, from its committed .semiont/config.yaml — "did:web:" + its site.domain, verbatim. REQUIRED: a KB that declares no domain has no identity to publish, and the launcher refuses to start it rather than inventing or defaulting one. NOT unique within a document: a did names the knowledge base, not a running copy of it, so a local clone and a codespace of the same repo legitimately share one and both are published. host:port is the unique field (at most one entry per address), so consumers look up by ADDRESS and use the did to VERIFY that the copy they reached is the KB they meant — an address alone cannot say which KB is which, and an identity alone cannot say which copy. */
  did?: NonNullable<DiscoveredKB['did']>;
  /** Human-readable site name from the KB's .semiont/config.yaml (site.siteName), for display */
  siteName?: NonNullable<DiscoveredKB['siteName']>;
  /** Why its identity could not be read from its clone, when it could not. */
  identityError?: string;
  /** The Inference document a start of it runs, as the registry records it. */
  config?: string;
  /** For a present local root: the Inference documents its clone has, as start --config names them. */
  configs?: string[];
  /** owner/name GitHub slug — present for codespace placements, where the repo is the stack's identity */
  repo?: NonNullable<DiscoveredKB['repo']>;
  /** For a codespace root: the codespace's name. */
  codespace?: string;
  /** For a codespace root: GitHub's word for the codespace's state (Available, Shutdown), when gh answered. */
  codespaceState?: string;
  /** For a codespace root: the port on this machine its knowledge base is forwarded to, when one is recorded. */
  forwardPort?: number;
  /** For a codespace root: whether the recorded forward is alive. */
  forwarded?: boolean;
  /** For a codespace root: whether its knowledge base answers through the forward. */
  reachable?: boolean;
}

/** roots.init's params: the local directory, permanent identity, and optional configuration inputs semiont init takes. */
export interface ControlRootsInitParams {
  /** The group and version of the control API. Every request's params state it; a launcher refuses a version it does not speak with control.unsupported-api-version, and names the ones it does. */
  apiVersion: ControlApiVersion;
  /** Existing local directory in which to create the knowledge base. */
  path: string;
  /** The permanent did:web domain, in colon-path form, such as owner.github.io:repo. */
  domain: string;
  /** Project name. Absent: the directory basename. */
  name?: string;
  /** Human-readable site name. Absent: the project name. */
  siteName?: string;
  /** Inference provider for the generated local stack documents. */
  inference?: "anthropic" | "ollama";
  /** The primary model bound to roles and jobs. */
  model?: string;
  /** A light model example emitted in the generated config. */
  modelLight?: string;
  /** Ollama embedding model name, without the ollama: prefix. */
  embedding?: string;
  /** Inference document name. Absent: the provider name. */
  configName?: string;
  /** Anthropic API base URL. */
  anthropicEndpoint?: string;
  /** Local Ollama API base URL. */
  ollamaBase?: string;
  /** Ollama registry base URL. */
  ollamaRegistry?: string;
}

/** The local directory where semiont init created and registered the knowledge base. */
export interface ControlRootsInitResult {
  path: string;
}

/** roots.forget's params. */
export interface ControlRootsForgetParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
  /** The registered root to forget: its path, or its basename when only one registered root has it. */
  root: string;
}

/** A forgotten registry row. Only the row is removed: no file of the clone, and none of its persistent stack state. */
export interface ControlRootsForgetResult {
  /** The forgotten root's path. */
  path: string;
  /** Whether its directory was already gone. */
  directoryMissing: boolean;
  /** The key whose persistent stack state remains, when some does and no surviving root shares its DID: semiont clean --root <key> removes it. */
  persistentState?: string;
}

/** status.snapshot's params. */
export interface ControlStatusSnapshotParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
  /** Which knowledge base's stack. Absent: the one the command line chooses, standing where the control server was started. */
  target?: ControlTarget;
  /** The container runtime to ask, as --runtime names it. Absent: the one the stack's record names, else every installed one. */
  runtime?: ControlRuntime;
}

/** Which knowledge base an operation acts on: a local clone's stack, or a codespace's. The launcher resolves it as the command line resolves --root and --repo, and refuses a choice it would have to guess. */
export interface ControlTarget {
  /** Where the stack runs: on this machine (local), or on a GitHub codespace whose knowledge base is forwarded here (codespace). */
  kind: "local" | "codespace";
  /** For a local target: the knowledge base's clone, by path or by the basename of a registered root, as --root takes it. Absent: the local stack the command line chooses with --runtime, standing where the control server was started. */
  root?: string;
  /** For a codespace target: the GitHub repository, as --repo takes it. */
  repo?: string;
}

/** What semiont status reports: each knowledge base with its own services, and each service the knowledge bases share, once, with the knowledge bases it serves. */
export interface ControlStatusSnapshotResult {
  /** The target's stack; with no target, the stack of the knowledge base the control server stands in, else every recorded one. */
  knowledgeBases: ControlKnowledgeBaseStatus[];
  /** The services every knowledge base shares, group by group, and those the machine serves for the knowledge bases that name them. */
  shared: ControlServiceStatus[];
}

/** One knowledge base's stack as semiont status reads it: what it is, where it runs, and each of its own services. The services every knowledge base shares are reported once, in the snapshot's shared list. */
export interface ControlKnowledgeBaseStatus {
  /** What the snapshot calls the knowledge base: the last segment of its DID, or the whole DID where two would share one, or its key. */
  name: string;
  /** The knowledge base's key on this machine, which names its containers and its state. */
  key: string;
  /** Whether a stack of it is recorded. When none is, its services are found by name. */
  recorded: boolean;
  /** Where the stack actually runs. "local": containers on this machine. "codespace": a GitHub-hosted VM whose KB is port-forwarded here. */
  placement: NonNullable<DiscoveredKB['placement']>;
  /** Its clone, for a local stack. */
  root?: string;
  /** owner/name GitHub slug — present for codespace placements, where the repo is the stack's identity */
  repo?: NonNullable<DiscoveredKB['repo']>;
  /** The KB's did:web identifier, from its committed .semiont/config.yaml — "did:web:" + its site.domain, verbatim. REQUIRED: a KB that declares no domain has no identity to publish, and the launcher refuses to start it rather than inventing or defaulting one. NOT unique within a document: a did names the knowledge base, not a running copy of it, so a local clone and a codespace of the same repo legitimately share one and both are published. host:port is the unique field (at most one entry per address), so consumers look up by ADDRESS and use the did to VERIFY that the copy they reached is the KB they meant — an address alone cannot say which KB is which, and an identity alone cannot say which copy. */
  did?: NonNullable<DiscoveredKB['did']>;
  /** Human-readable site name from the KB's .semiont/config.yaml (site.siteName), for display */
  siteName?: NonNullable<DiscoveredKB['siteName']>;
  /** Why its identity could not be read from its clone, when it could not. */
  identityError?: string;
  /** The knowledge base as the discovery document publishes it, when it does. */
  kb?: DiscoveredKB;
  /** The runtime its record names. */
  runtime?: ControlRuntime;
  /** The base URL of its gateway, from its record. */
  gateway?: string;
  /** Where the values the launcher generates for it are kept, as semiont settings secret-store describes it. */
  secretStore?: string;
  /** This machine's address on the network, when the stack is started with network lan. */
  lan?: string;
  /** Whether a semiont start of it holds its start lock: its services are not ready, whatever they report. */
  starting: boolean;
  /** The launcher's own stored sign-in for a stack (semiont login), never Desktop's. No token is in it. */
  session?: ControlSession;
  /** Whether each of its counted services, and the issuer it signs in at, answers. */
  healthy: boolean;
  /** Its own services, group by group, then the issuer it signs in at. Empty for a codespace's, whose services its own launcher reports. */
  services: ControlServiceStatus[];
  /** The ledger and job queue readings the launcher can attribute to this knowledge base. A missing reading means the Collector has not reported that metric, not that its value is zero. */
  workload?: ControlWorkloadStatus;
}

/** The launcher's own stored sign-in for a stack (semiont login), never Desktop's. No token is in it. */
export interface ControlSession {
  /** valid: the stack's gateway accepts the stored token. expired: it refuses it (a refresh, or semiont login, renews it). unverified: the stack did not answer. none: nothing is stored. */
  state: "valid" | "expired" | "unverified" | "none";
  /** The email the session was signed in as, when the store records one. */
  email?: string;
}

/** One service, as semiont status reads it: where it runs, its state, and whether it answers. Nothing is reported that the launcher did not observe: an endpoint is named only when the stack's record or the descriptor names one, and a page to open only when the service answers. */
export interface ControlServiceStatus {
  /** The service, as semiont status names it. */
  role: string;
  /** The group it belongs to. */
  group: ControlServiceGroup;
  /** The product its driver names (Neo4j, Keycloak), when its record names a driver. */
  product?: string;
  /** Where it runs: the runtime its container runs under, external (somebody else runs it), or host (a process on this machine). Absent when nothing runs it. */
  runsOn?: string;
  /** running: its container runs. stopped: its container exists and does not run (containerState says how). reachable, unreachable: somebody else runs it, and its endpoint answers or does not. absent: there is no container of it. not-configured: the stack's documents ask for none. */
  state: "running" | "stopped" | "reachable" | "unreachable" | "absent" | "not-configured";
  /** The runtime's own word for a container that is not running (exited, created). */
  containerState?: string;
  /** Whether its health endpoint answers. */
  healthy: boolean;
  /** Whether its health counts toward its knowledge base's: a service the documents ask for none of, and a telemetry backend --no-observe leaves out, do not. */
  counted: boolean;
  /** The endpoint the launcher asks its health of: an http URL, or tcp://host:port. */
  probe?: string;
  /** The page a person opens: the Browser, Jaeger's and Prometheus's interfaces, the collector's metrics readout. Present only when the service answers. The collector's OTLP receiver is never one. */
  page?: string;
  /** For the issuer the knowledge base signs in at, when it is the machine's: its realm there. */
  realm?: string;
  /** For a service several knowledge bases share: the name of each it serves, as knowledgeBases names them. */
  serves?: string[];
}

/** A group of services, as semiont status reports them and --group names them: a knowledge base's record and its index, the issuer that signs its accounts in, the knowledge workers where people and agents work on it, the providers of its models, and the telemetry that watches them all. */
export type ControlServiceGroup = "record" | "index" | "issuer" | "knowledge-workers" | "providers" | "telemetry";

/** A knowledge base's operational readings from Collector metrics. Request-tracking occupancy and queue depth are current gauges; completed and failed are worker counters since that worker process started. Missing readings are unknown, never zero. */
export interface ControlWorkloadStatus {
  /** The Gateway's request tracking: correlation IDs it currently holds so replies can be routed to the app client that sent each request, and the tracking capacity. */
  ledger?: ControlWorkloadStatusLedger;
  /** Current Dispatcher depth and, when the worker has emitted counters, completed and failed work since worker start. These are different measurements and time windows. */
  queue?: ControlWorkloadStatusQueue;
}

/** The Gateway's request tracking: correlation IDs it currently holds so replies can be routed to the app client that sent each request, and the tracking capacity. */
export interface ControlWorkloadStatusLedger {
  /** Number of request IDs currently held to route replies to their requesting app clients. Includes requests still waiting for a reply and recently answered requests still within the tracking window. */
  claims: number;
  /** The maximum number of IDs held in this Gateway's local tracking projection. */
  capacity: number;
}

/** Current Dispatcher depth and, when the worker has emitted counters, completed and failed work since worker start. These are different measurements and time windows. */
export interface ControlWorkloadStatusQueue {
  /** Jobs currently waiting for a worker. */
  pending: number;
  /** Jobs currently claimed by workers. */
  running: number;
  /** Jobs completed since worker start. */
  completed?: number;
  /** Jobs finally failed since worker start. */
  failed?: number;
}

/** stack.start's params: what semiont start takes, but its help and its narration switches. */
export interface ControlStackStartParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
  /** Which knowledge base's stack. Absent: the one the command line chooses, standing where the control server was started. */
  target?: ControlTarget;
  /** The container runtime to ask, as --runtime names it. Absent: the one the stack's record names, else every installed one. */
  runtime?: ControlRuntime;
  /** The Inference document to run, as --config names it. Absent: the knowledge base's recorded preference, else the default. */
  config?: string;
  /** Just this one service, as --service names it. */
  service?: string;
  /** Just this one group of services, as --group names it. */
  group?: ControlServiceGroup;
  /** For a codespace target: which of the repository's codespaces, as --codespace names it. */
  codespaceName?: string;
  /** For a codespace target being created: its VM class, as --machine names it. */
  machine?: string;
  /** For a codespace target being created: inactivity before it stops, as --idle-timeout takes it. */
  idleTimeout?: string;
  /** For a codespace target being created: how long a stopped codespace is kept, as --retention-period takes it. */
  retentionPeriod?: string;
  /** Whether to start the telemetry backends, Jaeger and Prometheus. false is --no-observe. Absent: true. */
  observe?: boolean;
  /** Where a started Ollama keeps its models, as --ollama-cache names it. Absent: the host's ~/.ollama when there is one, else the named volume — what the command line's prompt does when nobody answers it. */
  ollamaCache?: "host" | "volume";
  /** Whether to run nothing, and report each runtime command a start would run as a command progress line. */
  dryRun?: boolean;
}

/** A start that ran to its end: the stack as status reads it afterwards. A start that failed is an error, whatever it started before it did; its progress lines say what it did. */
export interface ControlStackStartResult {
  /** Whether the start ran nothing. */
  dryRun: boolean;
  /** The started knowledge base's stack, as status reads it after the start. Absent from a dry run, and from a start of services no knowledge base owns. */
  knowledgeBase?: ControlKnowledgeBaseStatus;
  /** The shared services, as status reads them after the start. Absent from a dry run. */
  shared?: ControlServiceStatus[];
}

/** stack.stop's params: what semiont stop takes, but its help. */
export interface ControlStackStopParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
  /** Which knowledge base's stack. Absent: the one the command line chooses, standing where the control server was started. */
  target?: ControlTarget;
  /** The container runtime to ask, as --runtime names it. Absent: the one the stack's record names, else every installed one. */
  runtime?: ControlRuntime;
  /** Just this one service, as --service names it. */
  service?: string;
  /** Just this one group of services, as --group names it. */
  group?: ControlServiceGroup;
  /** For a codespace target: destroy the codespace, state and all, and forget its record. The command line's --delete. Refused without deleteConfirmed. */
  delete?: boolean;
  /** That the person confirmed the deletion: delete is refused with control.confirmation-required without it. */
  deleteConfirmed?: boolean;
  /** Whether to stop nothing, and report each runtime command a stop would run as a command progress line. */
  dryRun?: boolean;
}

/** A stop that ran to its end: what status reads afterwards. A stop that failed is an error. */
export interface ControlStackStopResult {
  /** Whether the stop stopped nothing. */
  dryRun: boolean;
  /** The knowledge bases still recorded, as status reads them after the stop. Absent from a dry run. */
  knowledgeBases?: ControlKnowledgeBaseStatus[];
  /** The shared services, as status reads them after the stop. Absent from a dry run. */
  shared?: ControlServiceStatus[];
}

/** auth.login's params. */
export interface ControlAuthLoginParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
  /** Which knowledge base's stack. Absent: the one the command line chooses, standing where the control server was started. */
  target?: ControlTarget;
  /** Keep to the local stacks, as --runtime does. */
  runtime?: ControlRuntime;
}

/** A completed sign-in, kept in the launcher's sign-in store. No token is in it. */
export interface ControlAuthLoginResult {
  /** The stack's key in the sign-in store. */
  key: string;
  /** Who the gateway says is signed in: their email, else their DID. */
  who: string;
  /** The issuer the knowledge base named, where the person signed in. */
  issuer: string;
}

/** auth.logout's params. */
export interface ControlAuthLogoutParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
  /** Which knowledge base's stack. Absent: the one the command line chooses, standing where the control server was started. */
  target?: ControlTarget;
  /** Keep to the local stacks, as --runtime does. */
  runtime?: ControlRuntime;
}

/** The launcher's session for a stack, ended. Desktop's own session is not touched. */
export interface ControlAuthLogoutResult {
  /** The stack's key in the sign-in store. Absent when no stack is recorded. */
  key?: string;
  /** Whether a session was stored. false: nothing was done. */
  wasSignedIn: boolean;
  /** Whether the issuer revoked the session's refresh token. false with wasSignedIn: the local token is forgotten, and the refresh token stays valid at the issuer until it expires. */
  revoked: boolean;
}

/** Create one account in the launcher-managed Keycloak realm for a specific local knowledge base. */
export interface ControlIdentityUseraddParams {
  /** The group and version of the control API. Every request's params state it; a launcher refuses a version it does not speak with control.unsupported-api-version, and names the ones it does. */
  apiVersion: ControlApiVersion;
  /** The local knowledge base whose launcher-managed identity realm an operation addresses. */
  target: ControlIdentityLocalTarget;
  /** The email address that will sign in to this knowledge base. */
  email: string;
  /** The user's password. Secret: carried only in this local control request, never in progress, diagnostics, or persistent state. */
  password?: string;
  /** Generate a random password in the launcher and return it once in the result. */
  generatePassword: boolean;
}

/** The local knowledge base whose launcher-managed identity realm an operation addresses. */
export interface ControlIdentityLocalTarget {
  /** Identity administration here is limited to local stacks. */
  kind: "local";
  /** The selected knowledge base's clone path. */
  root: string;
}

/** The created account's sign-in identity. A generated password is present only in this one answer and is not stored by the launcher. */
export interface ControlIdentityUseraddResult {
  /** The account's email address. */
  email: string;
  /** The identity the account acts under in Semiont. */
  identity: string;
  /** Whether a new account was created. */
  created: boolean;
  /** The generated password, returned once so the operator can share it with the user. Absent when the operator supplied the password. */
  generatedPassword?: string;
}

/** List accounts in one local knowledge base's launcher-managed Keycloak realm. */
export interface ControlIdentityUsersListParams {
  /** The group and version of the control API. Every request's params state it; a launcher refuses a version it does not speak with control.unsupported-api-version, and names the ones it does. */
  apiVersion: ControlApiVersion;
  /** The local knowledge base whose launcher-managed identity realm an operation addresses. */
  target: ControlIdentityLocalTarget;
}

/** Accounts in the selected knowledge base's launcher-managed identity realm. */
export interface ControlIdentityUsersListResult {
  /** Accounts, sorted by sign-in name. */
  users: ControlIdentityUser[];
}

/** An account in a knowledge base's launcher-managed identity realm. Passwords and tokens are never included. */
export interface ControlIdentityUser {
  /** The account's sign-in name, normally its email address. */
  email: string;
  /** The identity the account acts under in Semiont. */
  identity: string;
  /** Whether the identity provider currently allows this account to sign in. */
  enabled: boolean;
}

/** logs.follow's params. */
export interface ControlLogsFollowParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
  /** Which knowledge base's stack. Absent: the one the command line chooses, standing where the control server was started. */
  target?: ControlTarget;
  /** Keep to the local stacks, as --runtime does. */
  runtime?: ControlRuntime;
  /** Just this service's container, as --service names it. Absent: each Semiont service the stack runs. */
  service?: string;
}

/** A follow whose every source ended on its own. A follow the client cancels is answered with control.cancelled. */
export interface ControlLogsFollowResult {
  /** The services that were followed. */
  services: string[];
}

/** settings.list's params. */
export interface ControlSettingsListParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
  /** A knowledge base's clone, by path or by the basename of a registered root, as --root takes it. Absent: the clone the control server was started in. */
  root?: string;
}

/** Every setting the launcher keeps: the machine's, then the knowledge base's. */
export interface ControlSettingsListResult {
  /** The knowledge base whose settings are listed, when one resolved. */
  root?: string;
  /** Why no knowledge base resolved, when none did: its settings are not listed. */
  unresolved?: string;
  /** Each setting. */
  settings: ControlSetting[];
}

/** One setting the launcher keeps, as semiont settings shows it. */
export interface ControlSetting {
  /** Its name, as semiont settings takes it. */
  name: string;
  /** Whether this is the machine-wide form of a knowledge-base setting (secret-store --default). */
  default: boolean;
  /** What it applies to: every knowledge base on this machine, or one. */
  appliesTo: "machine" | "knowledge-base";
  /** The values in effect, one per line semiont settings shows. */
  values: ControlSettingLine[];
  /** Whether settings.set and settings.unset change it. */
  settable: boolean;
  /** For one they do not: how it is changed instead. */
  changedBy?: string;
}

/** One value of a setting, and where it came from, as semiont settings shows it. A secret's value is never one: a secret setting shows where the value is kept. */
export interface ControlSettingLine {
  /** The value in effect. */
  value: string;
  /** Where it came from: a record, a document, the default. */
  source: string;
}

/** settings.get's params. */
export interface ControlSettingsGetParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
  /** The setting, as semiont settings names it. */
  name: string;
  /** The machine-wide form of a knowledge-base setting: --default. */
  default?: boolean;
  /** A knowledge base's clone, by path or by the basename of a registered root, as --root takes it. Absent: the clone the control server was started in. */
  root?: string;
}

/** settings.set's params. */
export interface ControlSettingsSetParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
  /** The setting, as semiont settings names it. */
  name: string;
  /** The machine-wide form of a knowledge-base setting: --default. */
  default?: boolean;
  /** A knowledge base's clone, by path or by the basename of a registered root, as --root takes it. Absent: the clone the control server was started in. */
  root?: string;
  /** The value, checked as a start would check it. */
  value: string;
}

/** settings.unset's params. */
export interface ControlSettingsUnsetParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
  /** The setting, as semiont settings names it. */
  name: string;
  /** The machine-wide form of a knowledge-base setting: --default. */
  default?: boolean;
  /** A knowledge base's clone, by path or by the basename of a registered root, as --root takes it. Absent: the clone the control server was started in. */
  root?: string;
}

/** settings.path's params. */
export interface ControlSettingsPathParams {
  /** The version of the control API the request is written to. */
  apiVersion: ControlApiVersion;
  /** Whose document: the Browser's, the worker's, the issuer's or the vector store's. */
  document: "browser" | "worker" | "issuer" | "vectors";
}

/** Where a machine document is. When there is none, it is written from the launcher's catalog first, as a start writes it; one that does not hold is refused, as a start refuses it. */
export interface ControlSettingsPathResult {
  /** The document's path. */
  path: string;
}

/** One line of what an operation is doing, as the command line would tell a person, without colour. A secret value the launcher generated or read never appears in one. */
export interface ControlProgress {
  /** The request a notification is about: the JSON-RPC id its client gave it, as the client gave it. */
  requestId: ControlRequestId;
  /** What the line is: narration (log, note), an outcome (ok, warn, fail), a heading (banner, section), a timestamp (stamp), a runtime command about to run (command), or text the operation printed (output). */
  kind: "log" | "note" | "ok" | "warn" | "fail" | "banner" | "section" | "stamp" | "command" | "output";
  /** The line. */
  text: string;
}

/** The request a notification is about: the JSON-RPC id its client gave it, as the client gave it. */
export type ControlRequestId = string | number;

/** A sign-in waits for a person: open the verification page and enter the code. The code is sent here and nowhere else — in no progress line, no log record and no diagnostic. */
export interface ControlUserAction {
  /** The request a notification is about: the JSON-RPC id its client gave it, as the client gave it. */
  requestId: ControlRequestId;
  /** The page where the person enters the code. */
  verificationUri: string;
  /** The page with the code already in it, when the issuer offers one. */
  verificationUriComplete?: string;
  /** The code the person enters. */
  userCode: string;
  /** How long the code is good for, from when it was issued. */
  expiresInSeconds: number;
}

/** One line one of a stack's services wrote. The launcher removes from it each secret value the launcher generated or read; anything else the service wrote is the client's to handle. The launcher keeps no copy. */
export interface ControlLogRecord {
  /** The request a notification is about: the JSON-RPC id its client gave it, as the client gave it. */
  requestId: ControlRequestId;
  /** The role whose container wrote the line, as semiont status names it. */
  service: string;
  /** Which of the container's streams the line was on. */
  stream: "stdout" | "stderr";
  /** The line, without its newline. */
  line: string;
  /** When the launcher read the line, in RFC 3339 with its fraction: a container's own lines carry the time it wrote them, if any. */
  receivedAt: string;
}

/** The client gives up on one of its requests. The launcher answers that request with control.cancelled, unless it has answered it already; a cancellation of a request it does not know is ignored. */
export interface ControlCancelled {
  /** The request a notification is about: the JSON-RPC id its client gave it, as the client gave it. */
  requestId: ControlRequestId;
  /** Why, for the launcher's diagnostics. */
  reason?: string;
}

/** The data of a control error: the launcher's code for the failure, one of protocol/specs/src/errors/codes.json's control group, and what a client can act on. A request's failure is never only a message. */
export interface ControlErrorData {
  /** Why the request failed: a code of the control group of protocol/specs/src/errors/codes.json. */
  code: string;
  /** Whether the same request can succeed sent again unchanged, once something outside it changes: a start finishes, a runtime is installed, a stack comes up. */
  retryable: boolean;
  /** For params the contract refuses: each fault, where it is. */
  fields?: ControlFieldFault[];
  /** For control.target-required and control.target-ambiguous: each target the request could have meant, to send again with one. */
  choices?: ControlTarget[];
  /** For control.unsupported-api-version: each version this launcher speaks. */
  supported?: string[];
  /** For a cancelled stack.start: whether services the start launched may still be running. The launcher stops waiting, and stops nothing. */
  mayStillRun?: boolean;
}

/** One fault in a request's params, named where it is. */
export interface ControlFieldFault {
  /** Where in the params the fault is, as a JSON pointer (RFC 6901); empty for the params as a whole. */
  field: string;
  /** What is wrong there. */
  message: string;
}

/** Each method's params and result. */
export interface ControlMethods {
  "launcher.about": { params: ControlAboutParams; result: ControlAboutResult };
  "roots.list": { params: ControlRootsListParams; result: ControlRootsListResult };
  "roots.init": { params: ControlRootsInitParams; result: ControlRootsInitResult };
  "roots.forget": { params: ControlRootsForgetParams; result: ControlRootsForgetResult };
  "status.snapshot": { params: ControlStatusSnapshotParams; result: ControlStatusSnapshotResult };
  "stack.start": { params: ControlStackStartParams; result: ControlStackStartResult };
  "stack.stop": { params: ControlStackStopParams; result: ControlStackStopResult };
  "auth.login": { params: ControlAuthLoginParams; result: ControlAuthLoginResult };
  "auth.logout": { params: ControlAuthLogoutParams; result: ControlAuthLogoutResult };
  "identity.useradd": { params: ControlIdentityUseraddParams; result: ControlIdentityUseraddResult };
  "identity.users.list": { params: ControlIdentityUsersListParams; result: ControlIdentityUsersListResult };
  "logs.follow": { params: ControlLogsFollowParams; result: ControlLogsFollowResult };
  "settings.list": { params: ControlSettingsListParams; result: ControlSettingsListResult };
  "settings.get": { params: ControlSettingsGetParams; result: ControlSetting };
  "settings.set": { params: ControlSettingsSetParams; result: ControlSetting };
  "settings.unset": { params: ControlSettingsUnsetParams; result: ControlSetting };
  "settings.path": { params: ControlSettingsPathParams; result: ControlSettingsPathResult };
}

export type ControlMethod = keyof ControlMethods;

/** Each notification the launcher sends, and its params. */
export interface ControlLauncherNotifications {
  "notifications/progress": ControlProgress;
  "notifications/userAction": ControlUserAction;
  "notifications/log": ControlLogRecord;
}

/** Each notification the client sends, and its params. */
export interface ControlClientNotifications {
  "notifications/cancelled": ControlCancelled;
}

/** Why a request failed: the control group of protocol/specs/src/errors/codes.json. */
export type ControlErrorCode =
  | "control.invalid-params"
  | "control.unsupported-api-version"
  | "control.invalid-request"
  | "control.invalid-service"
  | "control.invalid-value"
  | "control.unknown-setting"
  | "control.target-required"
  | "control.target-ambiguous"
  | "control.root-not-found"
  | "control.root-not-registered"
  | "control.stack-not-running"
  | "control.stack-running"
  | "control.start-in-progress"
  | "control.runtime-unavailable"
  | "control.dependency-unavailable"
  | "control.unreachable"
  | "control.confirmation-required"
  | "control.unreadable-state"
  | "control.already-signed-in"
  | "control.sign-in-failed"
  | "control.cancelled"
  | "control.failed";

/** The schema of each method's params and result, by its path in the repository. */
export const CONTROL_METHOD_SCHEMAS: { readonly [M in ControlMethod]: { readonly params: string; readonly result: string } } = {
  "launcher.about": { params: "protocol/specs/src/control/AboutParams.json", result: "protocol/specs/src/control/AboutResult.json" },
  "roots.list": { params: "protocol/specs/src/control/RootsListParams.json", result: "protocol/specs/src/control/RootsListResult.json" },
  "roots.init": { params: "protocol/specs/src/control/RootsInitParams.json", result: "protocol/specs/src/control/RootsInitResult.json" },
  "roots.forget": { params: "protocol/specs/src/control/RootsForgetParams.json", result: "protocol/specs/src/control/RootsForgetResult.json" },
  "status.snapshot": { params: "protocol/specs/src/control/StatusSnapshotParams.json", result: "protocol/specs/src/control/StatusSnapshotResult.json" },
  "stack.start": { params: "protocol/specs/src/control/StackStartParams.json", result: "protocol/specs/src/control/StackStartResult.json" },
  "stack.stop": { params: "protocol/specs/src/control/StackStopParams.json", result: "protocol/specs/src/control/StackStopResult.json" },
  "auth.login": { params: "protocol/specs/src/control/AuthLoginParams.json", result: "protocol/specs/src/control/AuthLoginResult.json" },
  "auth.logout": { params: "protocol/specs/src/control/AuthLogoutParams.json", result: "protocol/specs/src/control/AuthLogoutResult.json" },
  "identity.useradd": { params: "protocol/specs/src/control/IdentityUseraddParams.json", result: "protocol/specs/src/control/IdentityUseraddResult.json" },
  "identity.users.list": { params: "protocol/specs/src/control/IdentityUsersListParams.json", result: "protocol/specs/src/control/IdentityUsersListResult.json" },
  "logs.follow": { params: "protocol/specs/src/control/LogsFollowParams.json", result: "protocol/specs/src/control/LogsFollowResult.json" },
  "settings.list": { params: "protocol/specs/src/control/SettingsListParams.json", result: "protocol/specs/src/control/SettingsListResult.json" },
  "settings.get": { params: "protocol/specs/src/control/SettingsGetParams.json", result: "protocol/specs/src/control/Setting.json" },
  "settings.set": { params: "protocol/specs/src/control/SettingsSetParams.json", result: "protocol/specs/src/control/Setting.json" },
  "settings.unset": { params: "protocol/specs/src/control/SettingsUnsetParams.json", result: "protocol/specs/src/control/Setting.json" },
  "settings.path": { params: "protocol/specs/src/control/SettingsPathParams.json", result: "protocol/specs/src/control/SettingsPathResult.json" },
};

/** The schema of each launcher notification's params, by its path in the repository. */
export const CONTROL_NOTIFICATION_SCHEMAS: { readonly [N in keyof ControlLauncherNotifications]: string } = {
  "notifications/progress": "protocol/specs/src/control/Progress.json",
  "notifications/userAction": "protocol/specs/src/control/UserAction.json",
  "notifications/log": "protocol/specs/src/control/LogRecord.json",
};

/** The schema of a control error's data, by its path in the repository. */
export const CONTROL_ERROR_DATA_SCHEMA = "protocol/specs/src/control/ErrorData.json";

/** Every schema a control message is read against, and every one those refer to, by its path in the repository. */
export const CONTROL_SCHEMAS: { readonly [path: string]: object } = {
  "protocol/specs/src/control/AboutParams.json": {"title":"AboutParams","type":"object","description":"launcher.about's params.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."}},"required":["apiVersion"],"additionalProperties":false},
  "protocol/specs/src/control/AboutResult.json": {"title":"AboutResult","type":"object","description":"What the launcher is. A client asks this first, to learn whether it speaks to the launcher it found.","properties":{"version":{"type":"string","description":"The version stamped into the launcher at build. Absent from a development build, which states none."},"development":{"type":"boolean","description":"Whether this is a development build: one with no version stamped."},"commit":{"type":"string","description":"The commit it was built from, when stamped."},"built":{"type":"string","description":"When it was built, when stamped."},"apiVersions":{"type":"array","items":{"type":"string"},"description":"Each version of the control API it speaks. A client that speaks none of them stops here."},"imageRegistry":{"type":"string","description":"The registry its catalog's images come from."},"runtimes":{"type":"array","items":{"$ref":"./RuntimeState.json"},"description":"Each container runtime it drives, in the order it prefers them, and whether this machine has it."}},"required":["development","apiVersions","imageRegistry","runtimes"],"additionalProperties":false},
  "protocol/specs/src/control/ApiVersion.json": {"title":"ApiVersion","type":"string","const":"control.semiont.the-ai-alliance.github.io/v1alpha1","description":"The group and version of the control API. Every request's params state it; a launcher refuses a version it does not speak with control.unsupported-api-version, and names the ones it does."},
  "protocol/specs/src/control/AuthLoginParams.json": {"title":"AuthLoginParams","type":"object","description":"auth.login's params.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."},"target":{"$ref":"./Target.json","description":"Which knowledge base's stack. Absent: the one the command line chooses, standing where the control server was started."},"runtime":{"$ref":"./Runtime.json","description":"Keep to the local stacks, as --runtime does."}},"required":["apiVersion"],"additionalProperties":false},
  "protocol/specs/src/control/AuthLoginResult.json": {"title":"AuthLoginResult","type":"object","description":"A completed sign-in, kept in the launcher's sign-in store. No token is in it.","properties":{"key":{"type":"string","description":"The stack's key in the sign-in store."},"who":{"type":"string","description":"Who the gateway says is signed in: their email, else their DID."},"issuer":{"type":"string","description":"The issuer the knowledge base named, where the person signed in."}},"required":["key","who","issuer"],"additionalProperties":false},
  "protocol/specs/src/control/AuthLogoutParams.json": {"title":"AuthLogoutParams","type":"object","description":"auth.logout's params.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."},"target":{"$ref":"./Target.json","description":"Which knowledge base's stack. Absent: the one the command line chooses, standing where the control server was started."},"runtime":{"$ref":"./Runtime.json","description":"Keep to the local stacks, as --runtime does."}},"required":["apiVersion"],"additionalProperties":false},
  "protocol/specs/src/control/AuthLogoutResult.json": {"title":"AuthLogoutResult","type":"object","description":"The launcher's session for a stack, ended. Desktop's own session is not touched.","properties":{"key":{"type":"string","description":"The stack's key in the sign-in store. Absent when no stack is recorded."},"wasSignedIn":{"type":"boolean","description":"Whether a session was stored. false: nothing was done."},"revoked":{"type":"boolean","description":"Whether the issuer revoked the session's refresh token. false with wasSignedIn: the local token is forgotten, and the refresh token stays valid at the issuer until it expires."}},"required":["wasSignedIn","revoked"],"additionalProperties":false},
  "protocol/specs/src/control/Cancelled.json": {"title":"Cancelled","type":"object","description":"The client gives up on one of its requests. The launcher answers that request with control.cancelled, unless it has answered it already; a cancellation of a request it does not know is ignored.","properties":{"requestId":{"$ref":"./RequestId.json"},"reason":{"type":"string","description":"Why, for the launcher's diagnostics."}},"required":["requestId"],"additionalProperties":false},
  "protocol/specs/src/control/ErrorData.json": {"title":"ErrorData","type":"object","description":"The data of a control error: the launcher's code for the failure, one of protocol/specs/src/errors/codes.json's control group, and what a client can act on. A request's failure is never only a message.","properties":{"code":{"type":"string","description":"Why the request failed: a code of the control group of protocol/specs/src/errors/codes.json.","pattern":"^control\\.[a-z]+(-[a-z]+)*$"},"retryable":{"type":"boolean","description":"Whether the same request can succeed sent again unchanged, once something outside it changes: a start finishes, a runtime is installed, a stack comes up."},"fields":{"type":"array","items":{"$ref":"./FieldFault.json"},"description":"For params the contract refuses: each fault, where it is."},"choices":{"type":"array","items":{"$ref":"./Target.json"},"description":"For control.target-required and control.target-ambiguous: each target the request could have meant, to send again with one."},"supported":{"type":"array","items":{"type":"string"},"description":"For control.unsupported-api-version: each version this launcher speaks."},"mayStillRun":{"type":"boolean","description":"For a cancelled stack.start: whether services the start launched may still be running. The launcher stops waiting, and stops nothing."}},"required":["code","retryable"],"additionalProperties":false},
  "protocol/specs/src/control/FieldFault.json": {"title":"FieldFault","type":"object","description":"One fault in a request's params, named where it is.","properties":{"field":{"type":"string","description":"Where in the params the fault is, as a JSON pointer (RFC 6901); empty for the params as a whole."},"message":{"type":"string","description":"What is wrong there."}},"required":["field","message"],"additionalProperties":false},
  "protocol/specs/src/control/IdentityLocalTarget.json": {"title":"IdentityLocalTarget","type":"object","description":"The local knowledge base whose launcher-managed identity realm an operation addresses.","properties":{"kind":{"type":"string","const":"local","description":"Identity administration here is limited to local stacks."},"root":{"type":"string","minLength":1,"description":"The selected knowledge base's clone path."}},"required":["kind","root"],"additionalProperties":false},
  "protocol/specs/src/control/IdentityUser.json": {"title":"IdentityUser","type":"object","description":"An account in a knowledge base's launcher-managed identity realm. Passwords and tokens are never included.","properties":{"email":{"type":"string","description":"The account's sign-in name, normally its email address."},"identity":{"type":"string","description":"The identity the account acts under in Semiont."},"enabled":{"type":"boolean","description":"Whether the identity provider currently allows this account to sign in."}},"required":["email","identity","enabled"],"additionalProperties":false},
  "protocol/specs/src/control/IdentityUseraddParams.json": {"title":"IdentityUseraddParams","type":"object","description":"Create one account in the launcher-managed Keycloak realm for a specific local knowledge base.","properties":{"apiVersion":{"$ref":"./ApiVersion.json"},"target":{"$ref":"./IdentityLocalTarget.json"},"email":{"type":"string","minLength":3,"description":"The email address that will sign in to this knowledge base."},"password":{"type":"string","minLength":1,"description":"The user's password. Secret: carried only in this local control request, never in progress, diagnostics, or persistent state."},"generatePassword":{"type":"boolean","description":"Generate a random password in the launcher and return it once in the result."}},"required":["apiVersion","target","email","generatePassword"],"additionalProperties":false,"oneOf":[{"required":["password"],"properties":{"generatePassword":{"const":false}}},{"properties":{"generatePassword":{"const":true}},"not":{"required":["password"]}}]},
  "protocol/specs/src/control/IdentityUseraddResult.json": {"title":"IdentityUseraddResult","type":"object","description":"The created account's sign-in identity. A generated password is present only in this one answer and is not stored by the launcher.","properties":{"email":{"type":"string","description":"The account's email address."},"identity":{"type":"string","description":"The identity the account acts under in Semiont."},"created":{"type":"boolean","description":"Whether a new account was created."},"generatedPassword":{"type":"string","description":"The generated password, returned once so the operator can share it with the user. Absent when the operator supplied the password."}},"required":["email","identity","created"],"additionalProperties":false},
  "protocol/specs/src/control/IdentityUsersListParams.json": {"title":"IdentityUsersListParams","type":"object","description":"List accounts in one local knowledge base's launcher-managed Keycloak realm.","properties":{"apiVersion":{"$ref":"./ApiVersion.json"},"target":{"$ref":"./IdentityLocalTarget.json"}},"required":["apiVersion","target"],"additionalProperties":false},
  "protocol/specs/src/control/IdentityUsersListResult.json": {"title":"IdentityUsersListResult","type":"object","description":"Accounts in the selected knowledge base's launcher-managed identity realm.","properties":{"users":{"type":"array","items":{"$ref":"./IdentityUser.json"},"description":"Accounts, sorted by sign-in name."}},"required":["users"],"additionalProperties":false},
  "protocol/specs/src/control/KnowledgeBaseStatus.json": {"title":"KnowledgeBaseStatus","type":"object","description":"One knowledge base's stack as semiont status reads it: what it is, where it runs, and each of its own services. The services every knowledge base shares are reported once, in the snapshot's shared list.","properties":{"name":{"type":"string","description":"What the snapshot calls the knowledge base: the last segment of its DID, or the whole DID where two would share one, or its key."},"key":{"type":"string","description":"The knowledge base's key on this machine, which names its containers and its state."},"recorded":{"type":"boolean","description":"Whether a stack of it is recorded. When none is, its services are found by name."},"placement":{"$ref":"../discovery/DiscoveredKB.json#/properties/placement"},"root":{"type":"string","description":"Its clone, for a local stack."},"repo":{"$ref":"../discovery/DiscoveredKB.json#/properties/repo"},"did":{"$ref":"../discovery/DiscoveredKB.json#/properties/did"},"siteName":{"$ref":"../discovery/DiscoveredKB.json#/properties/siteName"},"identityError":{"type":"string","description":"Why its identity could not be read from its clone, when it could not."},"kb":{"$ref":"../discovery/DiscoveredKB.json","description":"The knowledge base as the discovery document publishes it, when it does."},"runtime":{"$ref":"./Runtime.json","description":"The runtime its record names."},"gateway":{"type":"string","description":"The base URL of its gateway, from its record."},"secretStore":{"type":"string","description":"Where the values the launcher generates for it are kept, as semiont settings secret-store describes it."},"lan":{"type":"string","description":"This machine's address on the network, when the stack is started with network lan."},"starting":{"type":"boolean","description":"Whether a semiont start of it holds its start lock: its services are not ready, whatever they report."},"session":{"$ref":"./Session.json"},"healthy":{"type":"boolean","description":"Whether each of its counted services, and the issuer it signs in at, answers."},"services":{"type":"array","items":{"$ref":"./ServiceStatus.json"},"description":"Its own services, group by group, then the issuer it signs in at. Empty for a codespace's, whose services its own launcher reports."},"workload":{"$ref":"./WorkloadStatus.json","description":"The ledger and job queue readings the launcher can attribute to this knowledge base. A missing reading means the Collector has not reported that metric, not that its value is zero."}},"required":["name","key","recorded","placement","starting","healthy","services"],"additionalProperties":false},
  "protocol/specs/src/control/LogRecord.json": {"title":"LogRecord","type":"object","description":"One line one of a stack's services wrote. The launcher removes from it each secret value the launcher generated or read; anything else the service wrote is the client's to handle. The launcher keeps no copy.","properties":{"requestId":{"$ref":"./RequestId.json"},"service":{"type":"string","description":"The role whose container wrote the line, as semiont status names it."},"stream":{"type":"string","description":"Which of the container's streams the line was on.","enum":["stdout","stderr"]},"line":{"type":"string","description":"The line, without its newline."},"receivedAt":{"type":"string","description":"When the launcher read the line, in RFC 3339 with its fraction: a container's own lines carry the time it wrote them, if any.","minLength":1}},"required":["requestId","service","stream","line","receivedAt"],"additionalProperties":false},
  "protocol/specs/src/control/LogsFollowParams.json": {"title":"LogsFollowParams","type":"object","description":"logs.follow's params.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."},"target":{"$ref":"./Target.json","description":"Which knowledge base's stack. Absent: the one the command line chooses, standing where the control server was started."},"runtime":{"$ref":"./Runtime.json","description":"Keep to the local stacks, as --runtime does."},"service":{"type":"string","description":"Just this service's container, as --service names it. Absent: each Semiont service the stack runs.","minLength":1}},"required":["apiVersion"],"additionalProperties":false},
  "protocol/specs/src/control/LogsFollowResult.json": {"title":"LogsFollowResult","type":"object","description":"A follow whose every source ended on its own. A follow the client cancels is answered with control.cancelled.","properties":{"services":{"type":"array","items":{"type":"string"},"description":"The services that were followed."}},"required":["services"],"additionalProperties":false},
  "protocol/specs/src/control/Progress.json": {"title":"Progress","type":"object","description":"One line of what an operation is doing, as the command line would tell a person, without colour. A secret value the launcher generated or read never appears in one.","properties":{"requestId":{"$ref":"./RequestId.json"},"kind":{"type":"string","description":"What the line is: narration (log, note), an outcome (ok, warn, fail), a heading (banner, section), a timestamp (stamp), a runtime command about to run (command), or text the operation printed (output).","enum":["log","note","ok","warn","fail","banner","section","stamp","command","output"]},"text":{"type":"string","description":"The line."}},"required":["requestId","kind","text"],"additionalProperties":false},
  "protocol/specs/src/control/RequestId.json": {"title":"RequestId","type":["string","integer"],"description":"The request a notification is about: the JSON-RPC id its client gave it, as the client gave it."},
  "protocol/specs/src/control/Root.json": {"title":"Root","type":"object","description":"One knowledge base this machine knows: a registered or running local clone, or a codespace stack recorded here. Registration, the directory, the stack and the forward are separate facts, each stated as it is.","properties":{"placement":{"$ref":"../discovery/DiscoveredKB.json#/properties/placement"},"path":{"type":"string","description":"For a local root: the clone's path."},"present":{"type":"boolean","description":"For a local root: whether the directory exists. A registered root whose directory is gone is kept, and says so."},"current":{"type":"string","description":"For a local root: how the control server's own directory selects it, when it does — standing in it (cwd), or SEMIONT_ROOT.","enum":["cwd","semiont-root"]},"registered":{"type":"boolean","description":"Whether the registry (roots.json) records it."},"running":{"type":"boolean","description":"Whether a stack of it is recorded on this machine."},"lastUsed":{"type":"string","description":"When a command last used it, in RFC 3339, as the registry records it."},"did":{"$ref":"../discovery/DiscoveredKB.json#/properties/did"},"siteName":{"$ref":"../discovery/DiscoveredKB.json#/properties/siteName"},"identityError":{"type":"string","description":"Why its identity could not be read from its clone, when it could not."},"config":{"type":"string","description":"The Inference document a start of it runs, as the registry records it."},"configs":{"type":"array","items":{"type":"string"},"description":"For a present local root: the Inference documents its clone has, as start --config names them."},"repo":{"$ref":"../discovery/DiscoveredKB.json#/properties/repo"},"codespace":{"type":"string","description":"For a codespace root: the codespace's name."},"codespaceState":{"type":"string","description":"For a codespace root: GitHub's word for the codespace's state (Available, Shutdown), when gh answered."},"forwardPort":{"type":"integer","description":"For a codespace root: the port on this machine its knowledge base is forwarded to, when one is recorded."},"forwarded":{"type":"boolean","description":"For a codespace root: whether the recorded forward is alive."},"reachable":{"type":"boolean","description":"For a codespace root: whether its knowledge base answers through the forward."}},"required":["placement","registered","running"],"additionalProperties":false},
  "protocol/specs/src/control/RootsForgetParams.json": {"title":"RootsForgetParams","type":"object","description":"roots.forget's params.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."},"root":{"type":"string","description":"The registered root to forget: its path, or its basename when only one registered root has it.","minLength":1}},"required":["apiVersion","root"],"additionalProperties":false},
  "protocol/specs/src/control/RootsForgetResult.json": {"title":"RootsForgetResult","type":"object","description":"A forgotten registry row. Only the row is removed: no file of the clone, and none of its persistent stack state.","properties":{"path":{"type":"string","description":"The forgotten root's path."},"directoryMissing":{"type":"boolean","description":"Whether its directory was already gone."},"persistentState":{"type":"string","description":"The key whose persistent stack state remains, when some does and no surviving root shares its DID: semiont clean --root <key> removes it."}},"required":["path","directoryMissing"],"additionalProperties":false},
  "protocol/specs/src/control/RootsInitParams.json": {"title":"RootsInitParams","type":"object","description":"roots.init's params: the local directory, permanent identity, and optional configuration inputs semiont init takes.","properties":{"apiVersion":{"$ref":"./ApiVersion.json"},"path":{"type":"string","description":"Existing local directory in which to create the knowledge base.","minLength":1},"domain":{"type":"string","description":"The permanent did:web domain, in colon-path form, such as owner.github.io:repo.","minLength":1},"name":{"type":"string","description":"Project name. Absent: the directory basename.","minLength":1},"siteName":{"type":"string","description":"Human-readable site name. Absent: the project name.","minLength":1},"inference":{"type":"string","description":"Inference provider for the generated local stack documents.","enum":["anthropic","ollama"]},"model":{"type":"string","description":"The primary model bound to roles and jobs.","minLength":1},"modelLight":{"type":"string","description":"A light model example emitted in the generated config.","minLength":1},"embedding":{"type":"string","description":"Ollama embedding model name, without the ollama: prefix.","minLength":1},"configName":{"type":"string","description":"Inference document name. Absent: the provider name.","minLength":1},"anthropicEndpoint":{"type":"string","description":"Anthropic API base URL.","minLength":1},"ollamaBase":{"type":"string","description":"Local Ollama API base URL.","minLength":1},"ollamaRegistry":{"type":"string","description":"Ollama registry base URL.","minLength":1}},"required":["apiVersion","path","domain"],"additionalProperties":false},
  "protocol/specs/src/control/RootsInitResult.json": {"title":"RootsInitResult","type":"object","description":"The local directory where semiont init created and registered the knowledge base.","properties":{"path":{"type":"string","minLength":1}},"required":["path"],"additionalProperties":false},
  "protocol/specs/src/control/RootsListParams.json": {"title":"RootsListParams","type":"object","description":"roots.list's params.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."}},"required":["apiVersion"],"additionalProperties":false},
  "protocol/specs/src/control/RootsListResult.json": {"title":"RootsListResult","type":"object","description":"Every knowledge base this machine knows, as semiont roots lists them: the local roots first, then the codespace stacks.","properties":{"roots":{"type":"array","items":{"$ref":"./Root.json"},"description":"Each root."},"warnings":{"type":"array","items":{"type":"string"},"description":"What semiont roots warns of without failing: an invalid SEMIONT_ROOT, a clone whose project file is refused."}},"required":["roots"],"additionalProperties":false},
  "protocol/specs/src/control/Runtime.json": {"title":"Runtime","type":"string","enum":["container","docker","podman"],"description":"A container runtime the launcher drives, as --runtime names it: Apple container, Docker or Podman."},
  "protocol/specs/src/control/RuntimeState.json": {"title":"RuntimeState","type":"object","description":"One container runtime the launcher drives, and whether this machine has it.","properties":{"name":{"$ref":"./Runtime.json"},"found":{"type":"boolean","description":"Whether it is on the launcher's PATH."}},"required":["name","found"],"additionalProperties":false},
  "protocol/specs/src/control/ServiceGroup.json": {"title":"ServiceGroup","type":"string","enum":["record","index","issuer","knowledge-workers","providers","telemetry"],"description":"A group of services, as semiont status reports them and --group names them: a knowledge base's record and its index, the issuer that signs its accounts in, the knowledge workers where people and agents work on it, the providers of its models, and the telemetry that watches them all."},
  "protocol/specs/src/control/ServiceStatus.json": {"title":"ServiceStatus","type":"object","description":"One service, as semiont status reads it: where it runs, its state, and whether it answers. Nothing is reported that the launcher did not observe: an endpoint is named only when the stack's record or the descriptor names one, and a page to open only when the service answers.","properties":{"role":{"type":"string","description":"The service, as semiont status names it."},"group":{"$ref":"./ServiceGroup.json","description":"The group it belongs to."},"product":{"type":"string","description":"The product its driver names (Neo4j, Keycloak), when its record names a driver."},"runsOn":{"type":"string","description":"Where it runs: the runtime its container runs under, external (somebody else runs it), or host (a process on this machine). Absent when nothing runs it."},"state":{"type":"string","description":"running: its container runs. stopped: its container exists and does not run (containerState says how). reachable, unreachable: somebody else runs it, and its endpoint answers or does not. absent: there is no container of it. not-configured: the stack's documents ask for none.","enum":["running","stopped","reachable","unreachable","absent","not-configured"]},"containerState":{"type":"string","description":"The runtime's own word for a container that is not running (exited, created)."},"healthy":{"type":"boolean","description":"Whether its health endpoint answers."},"counted":{"type":"boolean","description":"Whether its health counts toward its knowledge base's: a service the documents ask for none of, and a telemetry backend --no-observe leaves out, do not."},"probe":{"type":"string","description":"The endpoint the launcher asks its health of: an http URL, or tcp://host:port."},"page":{"type":"string","description":"The page a person opens: the Browser, Jaeger's and Prometheus's interfaces, the collector's metrics readout. Present only when the service answers. The collector's OTLP receiver is never one."},"realm":{"type":"string","description":"For the issuer the knowledge base signs in at, when it is the machine's: its realm there."},"serves":{"type":"array","items":{"type":"string"},"description":"For a service several knowledge bases share: the name of each it serves, as knowledgeBases names them."}},"required":["role","group","state","healthy","counted"],"additionalProperties":false},
  "protocol/specs/src/control/Session.json": {"title":"Session","type":"object","description":"The launcher's own stored sign-in for a stack (semiont login), never Desktop's. No token is in it.","properties":{"state":{"type":"string","description":"valid: the stack's gateway accepts the stored token. expired: it refuses it (a refresh, or semiont login, renews it). unverified: the stack did not answer. none: nothing is stored.","enum":["valid","expired","unverified","none"]},"email":{"type":"string","description":"The email the session was signed in as, when the store records one."}},"required":["state"],"additionalProperties":false},
  "protocol/specs/src/control/Setting.json": {"title":"Setting","type":"object","description":"One setting the launcher keeps, as semiont settings shows it.","properties":{"name":{"type":"string","description":"Its name, as semiont settings takes it."},"default":{"type":"boolean","description":"Whether this is the machine-wide form of a knowledge-base setting (secret-store --default)."},"appliesTo":{"type":"string","description":"What it applies to: every knowledge base on this machine, or one.","enum":["machine","knowledge-base"]},"values":{"type":"array","items":{"$ref":"./SettingLine.json"},"description":"The values in effect, one per line semiont settings shows."},"settable":{"type":"boolean","description":"Whether settings.set and settings.unset change it."},"changedBy":{"type":"string","description":"For one they do not: how it is changed instead."}},"required":["name","default","appliesTo","values","settable"],"additionalProperties":false},
  "protocol/specs/src/control/SettingLine.json": {"title":"SettingLine","type":"object","description":"One value of a setting, and where it came from, as semiont settings shows it. A secret's value is never one: a secret setting shows where the value is kept.","properties":{"value":{"type":"string","description":"The value in effect."},"source":{"type":"string","description":"Where it came from: a record, a document, the default."}},"required":["value","source"],"additionalProperties":false},
  "protocol/specs/src/control/SettingsGetParams.json": {"title":"SettingsGetParams","type":"object","description":"settings.get's params.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."},"name":{"type":"string","description":"The setting, as semiont settings names it.","minLength":1},"default":{"type":"boolean","description":"The machine-wide form of a knowledge-base setting: --default."},"root":{"type":"string","description":"A knowledge base's clone, by path or by the basename of a registered root, as --root takes it. Absent: the clone the control server was started in.","minLength":1}},"required":["apiVersion","name"],"additionalProperties":false},
  "protocol/specs/src/control/SettingsListParams.json": {"title":"SettingsListParams","type":"object","description":"settings.list's params.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."},"root":{"type":"string","description":"A knowledge base's clone, by path or by the basename of a registered root, as --root takes it. Absent: the clone the control server was started in.","minLength":1}},"required":["apiVersion"],"additionalProperties":false},
  "protocol/specs/src/control/SettingsListResult.json": {"title":"SettingsListResult","type":"object","description":"Every setting the launcher keeps: the machine's, then the knowledge base's.","properties":{"root":{"type":"string","description":"The knowledge base whose settings are listed, when one resolved."},"unresolved":{"type":"string","description":"Why no knowledge base resolved, when none did: its settings are not listed."},"settings":{"type":"array","items":{"$ref":"./Setting.json"},"description":"Each setting."}},"required":["settings"],"additionalProperties":false},
  "protocol/specs/src/control/SettingsPathParams.json": {"title":"SettingsPathParams","type":"object","description":"settings.path's params.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."},"document":{"type":"string","description":"Whose document: the Browser's, the worker's, the issuer's or the vector store's.","enum":["browser","worker","issuer","vectors"]}},"required":["apiVersion","document"],"additionalProperties":false},
  "protocol/specs/src/control/SettingsPathResult.json": {"title":"SettingsPathResult","type":"object","description":"Where a machine document is. When there is none, it is written from the launcher's catalog first, as a start writes it; one that does not hold is refused, as a start refuses it.","properties":{"path":{"type":"string","description":"The document's path."}},"required":["path"],"additionalProperties":false},
  "protocol/specs/src/control/SettingsSetParams.json": {"title":"SettingsSetParams","type":"object","description":"settings.set's params.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."},"name":{"type":"string","description":"The setting, as semiont settings names it.","minLength":1},"default":{"type":"boolean","description":"The machine-wide form of a knowledge-base setting: --default."},"root":{"type":"string","description":"A knowledge base's clone, by path or by the basename of a registered root, as --root takes it. Absent: the clone the control server was started in.","minLength":1},"value":{"type":"string","description":"The value, checked as a start would check it.","minLength":1}},"required":["apiVersion","name","value"],"additionalProperties":false},
  "protocol/specs/src/control/SettingsUnsetParams.json": {"title":"SettingsUnsetParams","type":"object","description":"settings.unset's params.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."},"name":{"type":"string","description":"The setting, as semiont settings names it.","minLength":1},"default":{"type":"boolean","description":"The machine-wide form of a knowledge-base setting: --default."},"root":{"type":"string","description":"A knowledge base's clone, by path or by the basename of a registered root, as --root takes it. Absent: the clone the control server was started in.","minLength":1}},"required":["apiVersion","name"],"additionalProperties":false},
  "protocol/specs/src/control/StackStartParams.json": {"title":"StackStartParams","type":"object","description":"stack.start's params: what semiont start takes, but its help and its narration switches.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."},"target":{"$ref":"./Target.json","description":"Which knowledge base's stack. Absent: the one the command line chooses, standing where the control server was started."},"runtime":{"$ref":"./Runtime.json","description":"The container runtime to ask, as --runtime names it. Absent: the one the stack's record names, else every installed one."},"config":{"type":"string","description":"The Inference document to run, as --config names it. Absent: the knowledge base's recorded preference, else the default.","minLength":1},"service":{"type":"string","description":"Just this one service, as --service names it.","minLength":1},"group":{"$ref":"./ServiceGroup.json","description":"Just this one group of services, as --group names it."},"codespaceName":{"type":"string","description":"For a codespace target: which of the repository's codespaces, as --codespace names it.","minLength":1},"machine":{"type":"string","description":"For a codespace target being created: its VM class, as --machine names it.","minLength":1},"idleTimeout":{"type":"string","description":"For a codespace target being created: inactivity before it stops, as --idle-timeout takes it.","minLength":1},"retentionPeriod":{"type":"string","description":"For a codespace target being created: how long a stopped codespace is kept, as --retention-period takes it.","minLength":1},"observe":{"type":"boolean","description":"Whether to start the telemetry backends, Jaeger and Prometheus. false is --no-observe. Absent: true."},"ollamaCache":{"type":"string","description":"Where a started Ollama keeps its models, as --ollama-cache names it. Absent: the host's ~/.ollama when there is one, else the named volume — what the command line's prompt does when nobody answers it.","enum":["host","volume"]},"dryRun":{"type":"boolean","description":"Whether to run nothing, and report each runtime command a start would run as a command progress line."}},"required":["apiVersion"],"additionalProperties":false},
  "protocol/specs/src/control/StackStartResult.json": {"title":"StackStartResult","type":"object","description":"A start that ran to its end: the stack as status reads it afterwards. A start that failed is an error, whatever it started before it did; its progress lines say what it did.","properties":{"dryRun":{"type":"boolean","description":"Whether the start ran nothing."},"knowledgeBase":{"$ref":"./KnowledgeBaseStatus.json","description":"The started knowledge base's stack, as status reads it after the start. Absent from a dry run, and from a start of services no knowledge base owns."},"shared":{"type":"array","items":{"$ref":"./ServiceStatus.json"},"description":"The shared services, as status reads them after the start. Absent from a dry run."}},"required":["dryRun"],"additionalProperties":false},
  "protocol/specs/src/control/StackStopParams.json": {"title":"StackStopParams","type":"object","description":"stack.stop's params: what semiont stop takes, but its help.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."},"target":{"$ref":"./Target.json","description":"Which knowledge base's stack. Absent: the one the command line chooses, standing where the control server was started."},"runtime":{"$ref":"./Runtime.json","description":"The container runtime to ask, as --runtime names it. Absent: the one the stack's record names, else every installed one."},"service":{"type":"string","description":"Just this one service, as --service names it.","minLength":1},"group":{"$ref":"./ServiceGroup.json","description":"Just this one group of services, as --group names it."},"delete":{"type":"boolean","description":"For a codespace target: destroy the codespace, state and all, and forget its record. The command line's --delete. Refused without deleteConfirmed."},"deleteConfirmed":{"type":"boolean","description":"That the person confirmed the deletion: delete is refused with control.confirmation-required without it."},"dryRun":{"type":"boolean","description":"Whether to stop nothing, and report each runtime command a stop would run as a command progress line."}},"required":["apiVersion"],"additionalProperties":false},
  "protocol/specs/src/control/StackStopResult.json": {"title":"StackStopResult","type":"object","description":"A stop that ran to its end: what status reads afterwards. A stop that failed is an error.","properties":{"dryRun":{"type":"boolean","description":"Whether the stop stopped nothing."},"knowledgeBases":{"type":"array","items":{"$ref":"./KnowledgeBaseStatus.json"},"description":"The knowledge bases still recorded, as status reads them after the stop. Absent from a dry run."},"shared":{"type":"array","items":{"$ref":"./ServiceStatus.json"},"description":"The shared services, as status reads them after the stop. Absent from a dry run."}},"required":["dryRun"],"additionalProperties":false},
  "protocol/specs/src/control/StatusSnapshotParams.json": {"title":"StatusSnapshotParams","type":"object","description":"status.snapshot's params.","properties":{"apiVersion":{"$ref":"./ApiVersion.json","description":"The version of the control API the request is written to."},"target":{"$ref":"./Target.json","description":"Which knowledge base's stack. Absent: the one the command line chooses, standing where the control server was started."},"runtime":{"$ref":"./Runtime.json","description":"The container runtime to ask, as --runtime names it. Absent: the one the stack's record names, else every installed one."}},"required":["apiVersion"],"additionalProperties":false},
  "protocol/specs/src/control/StatusSnapshotResult.json": {"title":"StatusSnapshotResult","type":"object","description":"What semiont status reports: each knowledge base with its own services, and each service the knowledge bases share, once, with the knowledge bases it serves.","properties":{"knowledgeBases":{"type":"array","items":{"$ref":"./KnowledgeBaseStatus.json"},"description":"The target's stack; with no target, the stack of the knowledge base the control server stands in, else every recorded one."},"shared":{"type":"array","items":{"$ref":"./ServiceStatus.json"},"description":"The services every knowledge base shares, group by group, and those the machine serves for the knowledge bases that name them."}},"required":["knowledgeBases","shared"],"additionalProperties":false},
  "protocol/specs/src/control/Target.json": {"title":"Target","type":"object","description":"Which knowledge base an operation acts on: a local clone's stack, or a codespace's. The launcher resolves it as the command line resolves --root and --repo, and refuses a choice it would have to guess.","properties":{"kind":{"type":"string","description":"Where the stack runs: on this machine (local), or on a GitHub codespace whose knowledge base is forwarded here (codespace).","enum":["local","codespace"]},"root":{"type":"string","description":"For a local target: the knowledge base's clone, by path or by the basename of a registered root, as --root takes it. Absent: the local stack the command line chooses with --runtime, standing where the control server was started.","minLength":1},"repo":{"type":"string","description":"For a codespace target: the GitHub repository, as --repo takes it.","pattern":"^[^/\\s]+/[^/\\s]+$"}},"required":["kind"],"additionalProperties":false,"oneOf":[{"properties":{"kind":{"const":"local"}},"not":{"required":["repo"]}},{"properties":{"kind":{"const":"codespace"}},"required":["repo"],"not":{"required":["root"]}}]},
  "protocol/specs/src/control/UserAction.json": {"title":"UserAction","type":"object","description":"A sign-in waits for a person: open the verification page and enter the code. The code is sent here and nowhere else — in no progress line, no log record and no diagnostic.","properties":{"requestId":{"$ref":"./RequestId.json"},"verificationUri":{"type":"string","description":"The page where the person enters the code."},"verificationUriComplete":{"type":"string","description":"The page with the code already in it, when the issuer offers one."},"userCode":{"type":"string","description":"The code the person enters."},"expiresInSeconds":{"type":"integer","description":"How long the code is good for, from when it was issued.","minimum":0}},"required":["requestId","verificationUri","userCode","expiresInSeconds"],"additionalProperties":false},
  "protocol/specs/src/control/WorkloadStatus.json": {"title":"WorkloadStatus","type":"object","description":"A knowledge base's operational readings from Collector metrics. Request-tracking occupancy and queue depth are current gauges; completed and failed are worker counters since that worker process started. Missing readings are unknown, never zero.","properties":{"ledger":{"type":"object","description":"The Gateway's request tracking: correlation IDs it currently holds so replies can be routed to the app client that sent each request, and the tracking capacity.","properties":{"claims":{"type":"integer","minimum":0,"description":"Number of request IDs currently held to route replies to their requesting app clients. Includes requests still waiting for a reply and recently answered requests still within the tracking window."},"capacity":{"type":"integer","minimum":1,"description":"The maximum number of IDs held in this Gateway's local tracking projection."}},"required":["claims","capacity"],"additionalProperties":false},"queue":{"type":"object","description":"Current Dispatcher depth and, when the worker has emitted counters, completed and failed work since worker start. These are different measurements and time windows.","properties":{"pending":{"type":"integer","minimum":0,"description":"Jobs currently waiting for a worker."},"running":{"type":"integer","minimum":0,"description":"Jobs currently claimed by workers."},"completed":{"type":"integer","minimum":0,"description":"Jobs completed since worker start."},"failed":{"type":"integer","minimum":0,"description":"Jobs finally failed since worker start."}},"required":["pending","running"],"additionalProperties":false}},"additionalProperties":false},
  "protocol/specs/src/discovery/DiscoveredKB.json": {"title":"DiscoveredKB","type":"object","description":"One knowledge base the Semiont launcher manages on this machine, as published in the discovery document (see DiscoveryDocument). Endpoints and identity only — never credentials; login remains the consumer's per-KB business.","properties":{"host":{"type":"string","description":"Hostname the KB is reachable on from this machine (always \"localhost\" — local stacks bind locally and codespace KBs arrive through a local port forward)"},"port":{"type":"integer","description":"Local TCP port of the KB's API (the gateway port for a local stack; the allocated forward port for a codespace stack)"},"placement":{"type":"string","enum":["local","codespace"],"description":"Where the stack actually runs. \"local\": containers on this machine. \"codespace\": a GitHub-hosted VM whose KB is port-forwarded here."},"repo":{"type":"string","description":"owner/name GitHub slug — present for codespace placements, where the repo is the stack's identity"},"did":{"type":"string","description":"The KB's did:web identifier, from its committed .semiont/config.yaml — \"did:web:\" + its site.domain, verbatim. REQUIRED: a KB that declares no domain has no identity to publish, and the launcher refuses to start it rather than inventing or defaulting one. NOT unique within a document: a did names the knowledge base, not a running copy of it, so a local clone and a codespace of the same repo legitimately share one and both are published. host:port is the unique field (at most one entry per address), so consumers look up by ADDRESS and use the did to VERIFY that the copy they reached is the KB they meant — an address alone cannot say which KB is which, and an identity alone cannot say which copy."},"siteName":{"type":"string","description":"Human-readable site name from the KB's .semiont/config.yaml (site.siteName), for display"},"managedBy":{"type":"string","description":"The agent that owns this entry's lifecycle (the launcher writes \"semiont-launcher\"). Consumers treat managed entries as authoritative for themselves — upsert on appearance, remove on disappearance — and never touch entries they did not write."}},"required":["host","port","placement","did","managedBy"]},
};
