// Code generated from specs/src/stack and specs/src/kb-identity/ProjectConfig.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-stack-go.mjs

package stack

import semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"

// KnowledgeBase: A knowledge base's record and the services that keep it: the
// Gateway, the Dispatcher, the Archivist, and the broker between them. They
// live and die with the knowledge base.
type KnowledgeBase struct {
	// The group and version of Semiont's kinds. The group names who defines a
	// kind, under the domain the knowledge bases' DIDs use; which knowledge base
	// a document is about is said inside it.
	ApiVersion string `json:"apiVersion"`

	Kind string `json:"kind"`

	// What names a document, as Kubernetes names an object. Documents refer to
	// one another by `name`.
	Metadata Metadata `json:"metadata"`

	// The knowledge base's services, and how each runs.
	Spec KnowledgeBaseSpec `json:"spec"`
}

// Metadata: What names a document, as Kubernetes names an object. Documents
// refer to one another by `name`.
type Metadata struct {
	// The document's name: lower-case letters, digits and `-`, beginning and
	// ending with a letter or digit. It names the document, never the knowledge
	// base.
	Name string `json:"name"`

	// The Kubernetes namespace the document belongs in. The launcher reads none.
	Namespace *string `json:"namespace,omitempty"`

	// Kubernetes labels. The launcher reads none.
	Labels map[string]string `json:"labels,omitempty"`

	// Kubernetes annotations. The launcher reads none.
	Annotations map[string]string `json:"annotations,omitempty"`
}

// KnowledgeBaseSpec: The knowledge base's services, and how each runs.
type KnowledgeBaseSpec struct {
	// How much a service logs: the least severe level it writes, from error, the
	// most severe, to debug.
	LogLevel semiont.LogLevel `json:"logLevel"`

	// The Gateway: where every client and every service reaches the knowledge
	// base.
	Gateway KnowledgeBaseGateway `json:"gateway"`

	// The Dispatcher: it hands queued jobs to workers.
	Dispatcher KnowledgeBaseDispatcher `json:"dispatcher"`

	// The Archivist: it keeps the knowledge base's record in its working tree.
	Archivist KnowledgeBaseArchivist `json:"archivist"`

	// The broker the job queue and the signal plane share: the launcher's, run
	// from `image`, or somebody else's, at `external`.
	Messaging KnowledgeBaseMessaging `json:"messaging"`

	// The issuer the knowledge base trusts: an Issuer document the launcher
	// runs, named by `ref`, or somebody else's, at `external`.
	Issuer KnowledgeBaseIssuer `json:"issuer"`
}

// KnowledgeBaseGateway: The Gateway: where every client and every service
// reaches the knowledge base.
type KnowledgeBaseGateway struct {
	// The container image a service runs, as a registry names it:
	// `ghcr.io/the-ai-alliance/semiont-gateway:latest`.
	Image string `json:"image"`

	// What a container is given, in Kubernetes' spelling.
	Resources Resources `json:"resources"`

	// The port the Gateway is published on.
	Port int `json:"port"`

	// Where clients reach the Gateway: the server its API document names. A
	// service of the stack reaches it where the launcher places it, on `port`.
	PublicURL string `json:"publicURL"`
}

// Resources: What a container is given, in Kubernetes' spelling.
type Resources struct {
	// The most a container may use.
	Limits ResourcesLimits `json:"limits"`
}

// ResourcesLimits: The most a container may use.
type ResourcesLimits struct {
	// The memory ceiling: a whole number of gigabytes or megabytes, `8G` or
	// `512M`.
	Memory string `json:"memory"`
}

// KnowledgeBaseDispatcher: The Dispatcher: it hands queued jobs to workers.
type KnowledgeBaseDispatcher struct {
	// The container image a service runs, as a registry names it:
	// `ghcr.io/the-ai-alliance/semiont-gateway:latest`.
	Image string `json:"image"`

	// What a container is given, in Kubernetes' spelling.
	Resources Resources `json:"resources"`
}

// KnowledgeBaseArchivist: The Archivist: it keeps the knowledge base's record
// in its working tree.
type KnowledgeBaseArchivist struct {
	// The container image a service runs, as a registry names it:
	// `ghcr.io/the-ai-alliance/semiont-gateway:latest`.
	Image string `json:"image"`

	// What a container is given, in Kubernetes' spelling.
	Resources Resources `json:"resources"`

	// Where the stack's services reach the Archivist, when that is somewhere the
	// launcher cannot see. Absent, they reach it where the launcher places it.
	Address *HostPort `json:"address,omitempty"`
}

// HostPort: Where somebody else's daemon listens.
type HostPort struct {
	// A host name or address the stack's containers can reach.
	Host string `json:"host"`

	// The port it listens on.
	Port int `json:"port"`
}

// KnowledgeBaseMessaging: The broker the job queue and the signal plane
// share: the launcher's, run from `image`, or somebody else's, at `external`.
type KnowledgeBaseMessaging struct {
	// The Dispatcher's queue.
	Jobs KnowledgeBaseMessagingJobs `json:"jobs"`

	// The Gateway's signal plane.
	Signal KnowledgeBaseMessagingSignal `json:"signal"`

	// The container image a service runs, as a registry names it:
	// `ghcr.io/the-ai-alliance/semiont-gateway:latest`.
	Image *string `json:"image,omitempty"`

	// What a container is given, in Kubernetes' spelling.
	Resources *Resources `json:"resources,omitempty"`

	// A broker somebody else runs.
	External *KnowledgeBaseMessagingExternal `json:"external,omitempty"`
}

// KnowledgeBaseMessagingJobs: The Dispatcher's queue.
type KnowledgeBaseMessagingJobs struct {
	// The queue's driver: `jetstream`.
	Type string `json:"type"`
}

// KnowledgeBaseMessagingSignal: The Gateway's signal plane.
type KnowledgeBaseMessagingSignal struct {
	// `in-process`, one Gateway on its own fabric, or `nats`, on the broker.
	Type string `json:"type"`
}

// KnowledgeBaseMessagingExternal: A broker somebody else runs.
type KnowledgeBaseMessagingExternal struct {
	// Where it listens: `host:port`.
	Servers string `json:"servers"`

	// A secret the document names and does not hold. The launcher hands it to
	// the service that needs it, from where the reference says it is.
	User SecretRef `json:"user"`

	// A secret the document names and does not hold. The launcher hands it to
	// the service that needs it, from where the reference says it is.
	Password SecretRef `json:"password"`
}

// SecretRef: A secret the document names and does not hold. The launcher
// hands it to the service that needs it, from where the reference says it is.
type SecretRef struct {
	// The environment variable that holds the secret where the launcher runs.
	// Unset, the start that needs it is refused.
	FromEnv string `json:"fromEnv"`
}

// KnowledgeBaseIssuer: The issuer the knowledge base trusts: an Issuer
// document the launcher runs, named by `ref`, or somebody else's, at
// `external`.
type KnowledgeBaseIssuer struct {
	// The name of the Issuer document.
	Ref *string `json:"ref,omitempty"`

	// An issuer somebody else runs.
	External *KnowledgeBaseIssuerExternal `json:"external,omitempty"`

	// The claim a person's DID is built from: did:web:<site domain>:users:<its
	// value>.
	SubjectClaim string `json:"subjectClaim"`
}

// KnowledgeBaseIssuerExternal: An issuer somebody else runs.
type KnowledgeBaseIssuerExternal struct {
	// `oidc`, or `keycloak`.
	Type string `json:"type"`

	// The URL in its tokens' `iss` claim.
	Url string `json:"url"`
}

// KnowledgeIndex: What a knowledge base's record is indexed into, and the
// services that keep and read the indexes: the Weaver's graph, the Smelter's
// vectors and anchored text, and the Librarian that answers from them. Each
// can be rebuilt from the record.
type KnowledgeIndex struct {
	// The group and version of Semiont's kinds. The group names who defines a
	// kind, under the domain the knowledge bases' DIDs use; which knowledge base
	// a document is about is said inside it.
	ApiVersion string `json:"apiVersion"`

	Kind string `json:"kind"`

	// What names a document, as Kubernetes names an object. Documents refer to
	// one another by `name`.
	Metadata Metadata `json:"metadata"`

	// The indexes, the services that keep and read them, and the knowledge base
	// they index.
	Spec KnowledgeIndexSpec `json:"spec"`
}

// KnowledgeIndexSpec: The indexes, the services that keep and read them, and
// the knowledge base they index.
type KnowledgeIndexSpec struct {
	// The name of the KnowledgeBase document whose record this indexes.
	KnowledgeBase string `json:"knowledgeBase"`

	// How much a service logs: the least severe level it writes, from error, the
	// most severe, to debug.
	LogLevel semiont.LogLevel `json:"logLevel"`

	// The graph store the Weaver writes and the Librarian reads.
	Graph KnowledgeIndexGraph `json:"graph"`

	// The vector store the Smelter writes and the Librarian reads.
	Vectors KnowledgeIndexVectors `json:"vectors"`

	// The model that turns text into vectors. Vectors made by one model are not
	// comparable with another's, so the model is the index's.
	Embedding KnowledgeIndexEmbedding `json:"embedding"`

	// The Librarian: it answers gathers and searches from the indexes.
	Librarian KnowledgeIndexLibrarian `json:"librarian"`

	// The Smelter: it writes the vectors and the anchored text.
	Smelter KnowledgeIndexSmelter `json:"smelter"`

	// The Weaver: it writes the graph.
	Weaver KnowledgeIndexWeaver `json:"weaver"`
}

// KnowledgeIndexGraph: The graph store the Weaver writes and the Librarian
// reads.
type KnowledgeIndexGraph struct {
	// The graph store's driver: `neo4j`.
	Type string `json:"type"`

	// The user the services sign in to the store as.
	Username string `json:"username"`

	// Which of the store's databases holds the graph.
	Database string `json:"database"`

	// The container image a service runs, as a registry names it:
	// `ghcr.io/the-ai-alliance/semiont-gateway:latest`.
	Image *string `json:"image,omitempty"`

	// What a container is given, in Kubernetes' spelling.
	Resources *Resources `json:"resources,omitempty"`

	// A graph store somebody else runs.
	External *KnowledgeIndexGraphExternal `json:"external,omitempty"`
}

// KnowledgeIndexGraphExternal: A graph store somebody else runs.
type KnowledgeIndexGraphExternal struct {
	// Where it listens: `bolt://host:port`.
	Uri string `json:"uri"`

	// A secret the document names and does not hold. The launcher hands it to
	// the service that needs it, from where the reference says it is.
	Password SecretRef `json:"password"`
}

// KnowledgeIndexVectors: The vector store the Smelter writes and the
// Librarian reads.
type KnowledgeIndexVectors struct {
	// The vector store's driver: `qdrant`.
	Type string `json:"type"`

	// The container image a service runs, as a registry names it:
	// `ghcr.io/the-ai-alliance/semiont-gateway:latest`.
	Image *string `json:"image,omitempty"`

	// What a container is given, in Kubernetes' spelling.
	Resources *Resources `json:"resources,omitempty"`

	// A vector store somebody else runs.
	External *HostPort `json:"external,omitempty"`
}

// KnowledgeIndexEmbedding: The model that turns text into vectors. Vectors
// made by one model are not comparable with another's, so the model is the
// index's.
type KnowledgeIndexEmbedding struct {
	// Who serves the model: `ollama`, or `voyage`.
	Type string `json:"type"`

	// The model, as its provider names it.
	Model string `json:"model"`

	// How a text is cut before it is embedded.
	Chunking KnowledgeIndexEmbeddingChunking `json:"chunking"`

	// Where the provider's API is reached. An Ollama the machine runs is stated
	// by no endpoint.
	Endpoint *string `json:"endpoint,omitempty"`

	// A secret the document names and does not hold. The launcher hands it to
	// the service that needs it, from where the reference says it is.
	ApiKey *SecretRef `json:"apiKey,omitempty"`
}

// KnowledgeIndexEmbeddingChunking: How a text is cut before it is embedded.
type KnowledgeIndexEmbeddingChunking struct {
	// The size of a piece.
	ChunkSize int `json:"chunkSize"`

	// How much of one piece the next repeats.
	Overlap int `json:"overlap"`
}

// KnowledgeIndexLibrarian: The Librarian: it answers gathers and searches
// from the indexes.
type KnowledgeIndexLibrarian struct {
	// The container image a service runs, as a registry names it:
	// `ghcr.io/the-ai-alliance/semiont-gateway:latest`.
	Image string `json:"image"`

	// What a container is given, in Kubernetes' spelling.
	Resources Resources `json:"resources"`

	// How a gather waits.
	Gather KnowledgeIndexLibrarianGather `json:"gather"`

	// What a search by meaning keeps.
	Search KnowledgeIndexLibrarianSearch `json:"search"`
}

// KnowledgeIndexLibrarianGather: How a gather waits.
type KnowledgeIndexLibrarianGather struct {
	// How long a gather waits for the Smelter to settle a resource, in
	// milliseconds.
	SettleTimeoutMs int `json:"settleTimeoutMs"`
}

// KnowledgeIndexLibrarianSearch: What a search by meaning keeps.
type KnowledgeIndexLibrarianSearch struct {
	// The least similarity a hit by meaning must have.
	SemanticFloor float64 `json:"semanticFloor"`
}

// KnowledgeIndexSmelter: The Smelter: it writes the vectors and the anchored
// text.
type KnowledgeIndexSmelter struct {
	// The container image a service runs, as a registry names it:
	// `ghcr.io/the-ai-alliance/semiont-gateway:latest`.
	Image string `json:"image"`

	// What a container is given, in Kubernetes' spelling.
	Resources Resources `json:"resources"`

	// How many PDFs it works on at once. A page of a scan held for OCR is large;
	// one for each 2G of its memory is a reading of what fits.
	PdfsAtOnce int `json:"pdfsAtOnce"`
}

// KnowledgeIndexWeaver: The Weaver: it writes the graph.
type KnowledgeIndexWeaver struct {
	// The container image a service runs, as a registry names it:
	// `ghcr.io/the-ai-alliance/semiont-gateway:latest`.
	Image string `json:"image"`

	// What a container is given, in Kubernetes' spelling.
	Resources Resources `json:"resources"`
}

// Issuer: An issuer the launcher runs, and the database it keeps its realm
// in. A knowledge base trusts it by naming this document; one trusting
// somebody else's issuer has no Issuer document.
type Issuer struct {
	// The group and version of Semiont's kinds. The group names who defines a
	// kind, under the domain the knowledge bases' DIDs use; which knowledge base
	// a document is about is said inside it.
	ApiVersion string `json:"apiVersion"`

	Kind string `json:"kind"`

	// What names a document, as Kubernetes names an object. Documents refer to
	// one another by `name`.
	Metadata Metadata `json:"metadata"`

	// The issuer, and the database it keeps its realm in.
	Spec IssuerSpec `json:"spec"`
}

// IssuerSpec: The issuer, and the database it keeps its realm in.
type IssuerSpec struct {
	// The issuer's driver: `keycloak`.
	Type string `json:"type"`

	// The container image a service runs, as a registry names it:
	// `ghcr.io/the-ai-alliance/semiont-gateway:latest`.
	Image string `json:"image"`

	// What a container is given, in Kubernetes' spelling.
	Resources Resources `json:"resources"`

	// How long a token the realm mints stays valid, in seconds: the window in
	// which a disabled account can still act.
	AccessTokenLifespan int `json:"accessTokenLifespan"`

	// The database the issuer keeps its realm in.
	Database IssuerDatabase `json:"database"`
}

// IssuerDatabase: The database the issuer keeps its realm in.
type IssuerDatabase struct {
	// The database's driver: `postgres`.
	Type string `json:"type"`

	// The database the issuer keeps its realm in: a lowercase PostgreSQL
	// identifier, as PostgreSQL itself names an unquoted one. On a PostgreSQL
	// the launcher runs, the launcher creates it; on one somebody else runs
	// (`external`), it must already exist there.
	Name string `json:"name"`

	// The user the issuer signs in as.
	User string `json:"user"`

	// The container image a service runs, as a registry names it:
	// `ghcr.io/the-ai-alliance/semiont-gateway:latest`.
	Image *string `json:"image,omitempty"`

	// What a container is given, in Kubernetes' spelling.
	Resources *Resources `json:"resources,omitempty"`

	// A database somebody else runs.
	External *IssuerDatabaseExternal `json:"external,omitempty"`
}

// IssuerDatabaseExternal: A database somebody else runs.
type IssuerDatabaseExternal struct {
	// A host name or address the issuer can reach.
	Host string `json:"host"`

	// The port it listens on.
	Port int `json:"port"`

	// A secret the document names and does not hold. The launcher hands it to
	// the service that needs it, from where the reference says it is.
	Password SecretRef `json:"password"`
}

// WorkerPool: The workers that do a knowledge base's jobs. A worker needs
// only the Gateway, and an issuer's token with the worker's role; it can run
// anywhere, as many as are wanted.
type WorkerPool struct {
	// The group and version of Semiont's kinds. The group names who defines a
	// kind, under the domain the knowledge bases' DIDs use; which knowledge base
	// a document is about is said inside it.
	ApiVersion string `json:"apiVersion"`

	Kind string `json:"kind"`

	// What names a document, as Kubernetes names an object. Documents refer to
	// one another by `name`.
	Metadata Metadata `json:"metadata"`

	// The workers, and the knowledge base whose jobs they do.
	Spec WorkerPoolSpec `json:"spec"`
}

// WorkerPoolSpec: The workers, and the knowledge base whose jobs they do.
type WorkerPoolSpec struct {
	// The name of the KnowledgeBase document whose jobs the workers do.
	KnowledgeBase string `json:"knowledgeBase"`

	// How much a service logs: the least severe level it writes, from error, the
	// most severe, to debug.
	LogLevel semiont.LogLevel `json:"logLevel"`

	// The Worker.
	Worker WorkerPoolWorker `json:"worker"`
}

// WorkerPoolWorker: The Worker.
type WorkerPoolWorker struct {
	// The container image a service runs, as a registry names it:
	// `ghcr.io/the-ai-alliance/semiont-gateway:latest`.
	Image string `json:"image"`

	// What a container is given, in Kubernetes' spelling.
	Resources Resources `json:"resources"`
}

// Inference: The models a machine uses for a knowledge base: the providers it
// reaches, and which provider and model serve each role. A knowledge base's
// repository may carry several, one for each provider, and a machine chooses
// one.
type Inference struct {
	// The group and version of Semiont's kinds. The group names who defines a
	// kind, under the domain the knowledge bases' DIDs use; which knowledge base
	// a document is about is said inside it.
	ApiVersion string `json:"apiVersion"`

	Kind string `json:"kind"`

	// What names a document, as Kubernetes names an object. Documents refer to
	// one another by `name`.
	Metadata Metadata `json:"metadata"`

	// The providers, and who serves each role.
	Spec InferenceSpec `json:"spec"`
}

// InferenceSpec: The providers, and who serves each role.
type InferenceSpec struct {
	// Each provider a role names, and how it is reached.
	Providers map[semiont.ArchivistRosterRoleProvider]Provider `json:"providers"`

	// The provider and model serving each role: every job a worker does, and
	// each Librarian actor that asks a model.
	Roster semiont.ArchivistRoster `json:"roster"`
}

// Provider: How an inference provider is reached.
type Provider struct {
	// Where the provider's API is reached. Anthropic's own API, and an Ollama
	// the machine runs, are stated by no baseURL.
	BaseURL *string `json:"baseURL,omitempty"`

	// A secret the document names and does not hold. The launcher hands it to
	// the service that needs it, from where the reference says it is.
	ApiKey *SecretRef `json:"apiKey,omitempty"`
}

// ProjectConfig: A knowledge base's committed `.semiont/config.yaml`: its
// name, whether its changes are staged in git, and its permanent identity. A
// deployment's documents never restate any of it.
type ProjectConfig struct {
	// The knowledge base's name.
	Project ProjectConfigProject `json:"project"`

	// How the knowledge base's changes reach git.
	Git ProjectConfigGit `json:"git"`

	// The knowledge base's identity.
	Site ProjectConfigSite `json:"site"`
}

// ProjectConfigProject: The knowledge base's name.
type ProjectConfigProject struct {
	// The knowledge base's name, which decides where its state is kept.
	Name string `json:"name"`

	// A version the knowledge base's author gives it. Nothing changes it.
	Version *string `json:"version,omitempty"`
}

// ProjectConfigGit: How the knowledge base's changes reach git.
type ProjectConfigGit struct {
	// Whether changes to the working tree and the event log are staged in git as
	// they are made.
	Sync bool `json:"sync"`
}

// ProjectConfigSite: The knowledge base's identity.
type ProjectConfigSite struct {
	// The knowledge base's permanent identity, in did:web's colon-path form
	// (`owner.github.io:repo`): stamped into every event it records, so never a
	// machine's address and never changed.
	Domain string `json:"domain"`

	// The name people see for the knowledge base.
	SiteName string `json:"siteName"`
}
