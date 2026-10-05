# The Archivist

This document specifies the Archivist as it is implemented: the files it keeps and their formats,
the commands it records, the reads it answers, the facts it publishes, its HTTP surface, and how it
boots. It describes current behaviour. Behaviour that is a known defect is not stated as a rule
anywhere below; it is listed under [Known defects](#known-defects), and a rule section that touches
one says what happens and links there.

Channel payloads are named in [the registry](../../specs/src/bus/registry.json); the bus conventions
this document relies on (`_userId`, `correlationId`, scopes, audiences) are in
[EVENT-BUS.md](EVENT-BUS.md). The HTTP surface's shapes are in
[its OpenAPI document](../../specs/src/archivist/openapi.json). The job-lifecycle commands the
Archivist records are sent by the dispatcher and the workers, as [JOBS.md](JOBS.md) describes.

## The Archivist

**The Archivist keeps the knowledge base's record.** It has five jobs:

1. **Append events** to the event log, the system of record.
2. **Write content** to the working tree.
3. **Stage change** where a person can commit it.
4. **Keep the materialized views up to date** with the log.
5. **Serve browse requests** from the views, the log and the content.

It is the only process that mounts the knowledge base's working tree, and the only writer of the
log, the content and the views. It dials one thing, the gateway, for the bus. It holds no graph, no
vector store and no model: finding things is the Librarian's.

Two other services touch its files. The Librarian reads the view files and the people projection.
The Smelter writes the anchored-text store, which the Archivist reads. Those formats are schemas in
the spec, named where each file is described below.

## Configuration

**The Archivist reads one document, named by its `--config` flag,** and defaults nothing. The
document is an [`ArchivistConfig`](../../specs/src/components/schemas/ArchivistConfig.json): the
gateway's URL, the issuer, the working tree's root, the state volume, the anchored-text store's
directory, the roster
of who serves each role, the port of its HTTP surface, whether to skip the boot rebuild, the staging
bounds, and its log level and format. Its image passes `--config /etc/semiont/archivist.json`, and
the launcher writes the document there, resolved from the knowledge base's config. Started without
`--config`, or with a path that names no file, no JSON, or a document the schema refuses, the
Archivist writes the reason to stderr and exits with status 1 before it serves.

The document carries no secret. The Archivist's own account at the issuer is the pair
`SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET`; without both it does not start.

**What the knowledge base says of itself is read from the tree,** not from the document: the
committed `<root>/.semiont/config`, a TOML file.

| Key | Meaning | When absent |
|---|---|---|
| `[project] name` | The knowledge base's name; it names the state directory | The root directory's name |
| `[site] domain` | The knowledge base's identity: its DID is `did:web:<domain>`, and the audience of the tokens it accepts is `https://<domain>` with each `:` written `/` | The Archivist refuses to start |
| `[git] sync` | Whether changes are staged with git. Only the literal `true` enables it | Nothing is staged, and no git runs |

A config file that is absent or does not parse reads as every key absent.

**The roster** is who serves each role, behind `browse:agents-requested`: for each of the six job
types and the two actors that call a model (`gatherer`, `matcher`), a provider and a model, or
nothing. The Archivist applies no fallback. The knowledge base's config allows two — a job type
without a binding is served by `workers.default`, an actor without one by `make-meaning.default` —
and the launcher applies them when it writes the document. The same selection routes the work, in
the services that call the models; `roster-cases.json`
([specs/src/service-config](../../specs/src/service-config/roster-cases.json)) holds the two to one
answer.

## The record on disk

Three trees:

| Tree | Where | Holds |
|---|---|---|
| The working tree | `root` | The content, and under `.semiont/events/` the event log. Committed by people |
| The state directory | `<stateHome>/semiont/<name>/` | The views and projections. Rebuilt from the log; never committed |
| The anchored-text store | `anchoredTextDir` | Text extracted from content, with where each word is. Written by the Smelter |

### Identifiers and shards

A resource id is 1 to 128 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`. An id is checked against
that rule wherever it becomes a file or directory name, and a name that fails it is refused. The
Archivist mints resource ids and annotation ids as 32 lowercase hex digits.

Files are spread over two levels of directories, `<ab>/<cd>`, by the **shard** of a key: a 16-bit
number written as four lowercase hex digits and split in two. It is computed over the key's UTF-16
code units: start at 0; for each unit, multiply by 31 and add the unit, keeping the low 32 bits as a
signed integer; take the absolute value; take it modulo 65536.
`shard-cases.json` ([specs/src/archivist](../../specs/src/archivist/shard-cases.json)) is the table
every implementation runs.

| File | Key |
|---|---|
| A resource's event stream | the resource id |
| A resource's view | the resource id |
| A storage-uri index entry | the URI |
| An anchored-text entry | the content checksum |

### The event log

Each resource has a stream, a directory `<root>/.semiont/events/<ab>/<cd>/<resourceId>/`. Events
about the knowledge base itself, which name no resource, are in the stream
`<root>/.semiont/events/__system__/`, which is not sharded.

A stream is a sequence of files named `events-NNNNNN.jsonl`, numbered from `000001` in six decimal
digits. A file holds at most 10,000 events; the next event opens the next file. The first file is
created, empty, with the directory.

**A stored event is one line:** compact JSON in UTF-8, ended by a single newline. Its keys are the
event as the Archivist built it, then `id`, `timestamp` and `metadata`:

```
{"type":"mark:removed","resourceId":"<id>","userId":"did:web:…","version":1,"payload":{"annotationId":"<id>"},"id":"<uuid>","timestamp":"2026-01-01T00:00:00.000Z","metadata":{"sequenceNumber":7}}
```

| Key | Value |
|---|---|
| `type` | The event type |
| `resourceId` | The resource, for a resource's event. Absent from a `__system__` event |
| `userId` | The DID of whoever sent the command |
| `version` | `1` |
| `payload` | The event's payload, as the registry names it for the type |
| `id` | A version 4 UUID, lowercase with hyphens |
| `timestamp` | When the event was appended: UTC, to the millisecond, `YYYY-MM-DDTHH:mm:ss.sssZ` |
| `metadata` | `{"sequenceNumber": n}` |

A payload key whose value is absent is not written. A command's correlation id is never written: the
log stores facts, not routing.

**Sequence numbers** count from 1 within a stream, one per event, in the order appended. After a
restart a stream's next number follows the last event of its last file.

**Reading.** A stream is read file by file in file-number order. Blank lines are skipped. A line that
is not JSON is logged and skipped. A line of the shape `{"event": {…}, "metadata": {…}}` with no
top-level `type` is read as the event with that metadata. A read that fails for any reason but a
missing file reports the path it was reading.

### The views

**A resource's view** is the file `resources/<ab>/<cd>/<resourceId>.json` in the state directory, a
[`ResourceView`](../../specs/src/components/schemas/ResourceView.json): the resource's descriptor,
its annotations (a [`ResourceAnnotations`](../../specs/src/components/schemas/ResourceAnnotations.json)),
and `lastSequence`, the sequence number of the last event applied. It is written as JSON indented by
two spaces, to a temporary file beside it that is then renamed onto the path, so a reader sees a
whole document or none. A view file that is not JSON is logged and read as missing; it is left in
place for the next write to replace.

**Three projections hold what the `__system__` stream adds up to,** in
`projections/__system__/` in the state directory, each JSON indented by two spaces:

| File | Schema | Holds |
|---|---|---|
| `entitytypes.json` | [`EntityTypesProjection`](../../specs/src/components/schemas/EntityTypesProjection.json) | Every entity type added, each once, sorted |
| `tagschemas.json` | [`TagSchemasProjection`](../../specs/src/components/schemas/TagSchemasProjection.json) | Every tag schema added, sorted by `id` |
| `people.json` | [`PeopleProjection`](../../specs/src/components/schemas/PeopleProjection.json) | Each person's current name and since when, by DID |

A projection file that is absent reads as empty.

**The storage-uri index** answers which resource's content is at a place in the working tree. An
entry is the file `projections/storage-uri/<ab>/<cd>/<h>.json` in the state directory, where `<h>` is
the SHA-256 of the URI's UTF-8 bytes in lowercase hex. It is a
[`StorageUriEntry`](../../specs/src/components/schemas/StorageUriEntry.json), `uri` first, JSON
indented by two spaces.

### How each event changes the views

Every event of a resource's stream adds 1 to the view's `annotations.version`, sets
`annotations.updatedAt` to the event's timestamp, and raises `lastSequence` to the event's sequence
number. An event type not in this table changes nothing else.

| Event | Change |
|---|---|
| `yield:created` | The descriptor gains `name`, `entityTypes`, `dateCreated` (the event's timestamp), `wasAttributedTo` (the payload's, or else the sender alone), `isDraft`, and one representation: `mediaType` (the payload's `format`), `checksum`, `byteSize`, `rel` `original`, `language`, `storageUri`. `wasDerivedFrom` is the source resource when the payload names one; `generator` is the payload's when it has one. A storage-uri entry is written for `storageUri` |
| `yield:cloned` | As `yield:created` for `name`, `entityTypes`, `dateCreated`, `wasAttributedTo` and the representation; `sourceResourceId` is the payload's `parentResourceId`. A storage-uri entry is written |
| `yield:updated` | The first representation's `checksum` and `byteSize` become the payload's; `dateModified` becomes the event's timestamp |
| `yield:moved` | The first representation's `storageUri` becomes `toUri`; `dateModified` becomes the event's timestamp. The storage-uri entry for `fromUri` is removed and one for `toUri` written |
| `yield:representation-added` | The payload's representation is added, unless one with its `checksum` is held |
| `yield:representation-removed` | Every representation with the payload's `checksum` is removed |
| `mark:added` | The payload's annotation is added to the annotations, unless one with its `id` is held: the first recorded stands |
| `mark:removed` | The annotation with the payload's `annotationId` is removed |
| `mark:body-updated` | The named annotation's `body` becomes a list, and each operation is applied in order: `add` appends the item unless the body holds it; `remove` takes out the first item that matches; `replace` puts `newItem` in place of the first item matching `oldItem`. `modified` becomes the event's timestamp. Two items match when they have the same `type` and the same `source` (a `SpecificResource`) or `value` (a `TextualBody`), and the same `purpose` when the item asked for names one. An annotation the view does not hold is left alone |
| `mark:entity-tag-added` | The payload's `entityType` is added to the descriptor's `entityTypes`, once |
| `mark:entity-tag-removed` | It is removed |
| `mark:archived` | `archived` becomes `true`. The storage-uri entry stays |
| `mark:unarchived` | `archived` becomes `false` |
| `job:started`, `job:assigned`, `job:completed`, `job:failed` | Nothing but the three counters above |
| `frame:entity-type-added` | `entitytypes.json` gains the payload's `entityType`, once, and is sorted |
| `frame:tag-schema-added` | `tagschemas.json` gains the payload's `schema`, in place of one with the same `id` if it holds one, and is sorted by `id` |
| `person:profiled` | `people.json` records the sender's DID as `{name, since}`: the payload's `name` and the event's timestamp |

**An append is four steps in order:** write the line; change the views; attach the annotation to the
event if its type calls for it ([Enrichment](#enrichment)); publish the event
([Facts](#facts)). The changes to one resource's view are applied one event at a time.

When a resource has no view, the view is built from every event of its stream, in sequence order.

### The working tree

A resource's content is a file in the working tree, named by a **storage URI**: `file://` followed
by the file's path relative to the root. A URI that does not begin `file://` is refused:
`Invalid storage URI (must start with file://): <uri>`.

A **checksum** is the SHA-256 of the content's bytes, in lowercase hex.

- **Storing** content streams it to a temporary file beside the target, hashing and counting as it
  goes, and renames it onto the target. Directories above the target are created.
- **Registering** content reads the file already at a URI, hashes it, and refuses it if it is not
  the checksum expected: `Checksum mismatch for <uri>: expected <8 characters>... but got <8
  characters>...`, followed by a second line saying the file differs from the recorded checksum. It
  then stages the file.
- **Moving** renames the file, creating directories above the destination.
- **Removing** deletes the file, unless told to keep it. A file already gone is not an error.

### Staging

Staging records the working tree's changes where a person can commit them. When the knowledge base
syncs git, that is the git index; when it does not, nothing is staged and no git runs.

- **At boot,** the Archivist asks git whether the root is inside a work tree. If git cannot be run or
  answers no, the Archivist refuses to start: `The knowledge base's config says [git] sync = true,
  and <root> is not a git checkout (<why>). Make it one (git init), or set sync = false.`
- **A stage is queued,** and its caller has already succeeded. Pending paths are staged together,
  each once, by one `git add`, after `staging.flushMs` with no new change and never more than
  `staging.maxWaitMs` after the oldest pending change. Staged: a registered content file, a new
  stream's directory, and the log file after each append.
- **A batch that fails is a degradation, not an error:** it is logged and counted, and nothing is
  told to the caller. A batch that failed because git's index was locked is queued again.
- **git runs one command at a time per repository.** A command that finds the index locked is tried
  again after 50, 100, 200, 400, 800 and 1600 milliseconds.
- **A move and a remove wait for everything pending,** then change the file, then tell git: a move
  unstages the old path and stages the new; a remove unstages the path. If git cannot be run or
  finds no repository, the move or remove fails with the boot refusal's message; any other failure
  of git is a degradation.
- **The current branch** is read from git when asked. It is none when the knowledge base does not
  sync git, and none in a checkout with no commit.

The views and projections are outside the working tree and are never staged.

### The anchored-text store

The store holds, for content that is not plain text, the text extracted from it and where each word
is on the page. The Smelter writes it; the Archivist only reads it.

An entry is the file `<ab>/<cd>/<checksum>.json` in the store, keyed by the checksum of the content
it was extracted from. It is an
[`AnchoredTextEntry`](../../specs/src/components/schemas/AnchoredTextEntry.json), compact JSON with
`v` and `stamp` first: either the text with its lines and how it was extracted, or a decline naming
why nothing was extracted.

**The stamp is the writer's.** It identifies the code and the engines that derived an entry. The
writer states its current stamp, followed by a newline, in the file `STAMP` at the store's root,
before it writes or lists entries. A reader takes an entry only when the entry's `stamp` equals the
stated one. With no stamp stated, with an entry under another stamp, with no file, or with a file
that is not an entry, the read is a miss. A read never fails.

## Commands

The Archivist records what it is told on these channels. Every command carries `_userId`, the DID of
its sender, which the gateway sets. A reply carries the command's correlation id.

| Command | Reply | On failure | Appends |
|---|---|---|---|
| `yield:create` | `yield:create-ok` `{resourceId}` | `yield:create-failed` | `yield:created` |
| `yield:clone-persist` | `yield:clone-persist-ok` `{resourceId}` | `yield:clone-persist-failed` | `yield:cloned` |
| `yield:update` | `yield:update-ok` `{resourceId}` | `yield:update-failed` | `yield:updated` |
| `yield:mv` | none | `yield:move-failed` `{fromUri, message}` | `yield:moved` |
| `mark:create-request` | `mark:create-ok` `{annotationId}` | `mark:create-failed` | `mark:added` |
| `mark:create` | none | `mark:create-failed` | `mark:added` |
| `mark:commit` | `mark:commit-ok` `{persisted, annotationIds}` | `mark:commit-failed` | `mark:added`, one per new annotation |
| `mark:delete` | `mark:delete-ok` `{annotationId}` | `mark:delete-failed` | `mark:removed` |
| `mark:update-body` | none | `mark:body-update-failed` | `mark:body-updated` |
| `bind:update-body` | `bind:body-updated` | `bind:body-update-failed` | `mark:body-updated` |
| `mark:archive` | `mark:archive-ok` | `mark:archive-failed` | `mark:archived` |
| `mark:unarchive` | `mark:unarchive-ok` | `mark:unarchive-failed` | `mark:unarchived` |
| `mark:update-entity-types` | `mark:update-entity-types-ok` | `mark:update-entity-types-failed` | `mark:entity-tag-added` per type added, then `mark:entity-tag-removed` per type removed |
| `frame:add-entity-type` | `frame:entity-type-add-ok` | `frame:entity-type-add-failed` | `frame:entity-type-added` |
| `frame:add-tag-schema` | `frame:tag-schema-add-ok` | `frame:tag-schema-add-failed` | `frame:tag-schema-added` |
| `person:profile` | none | none | `person:profiled`, when the name is new |
| `job:start` | none | none | `job:started` |
| `job:assign` | none | none | `job:assigned` |
| `job:complete` | none | none | `job:completed` |
| `job:fail` | none | none | `job:failed` |

A failure reply is `{message}`, the reason in words. Commands on one channel are handled one at a
time, in the order they arrive. See [Known defects](#known-defects) for commands on different
channels.

### Attribution

Every recorded resource and annotation says who is behind it. The **requester** is who asked; the
**executor** is who sent the command. They differ when a worker sends a command to fulfil a job:
the requester is then whoever the job was assigned for.

- `creator` is the requester, as an agent.
- `generator` is the executor, when the executor is software (a DID of the form
  `did:web:<domain>:agents:<provider>:<model>`). A command may supply the generator, to say more
  about it; it must be the executor: `attribution: generator <id> is not the executor <did>`, and
  `attribution: a generator was supplied, but the executor <did> is not software`.
- `wasAttributedTo` is the executor alone when it is also the requester, otherwise the creator then
  the executor.

**A command that cites a job** (`jobId`) is checked against the record: the log of the resource the
job was assigned on must hold a `job:assigned` for that job, and its `holder` must be the sender.
Otherwise: `refused: cites job <id>, but this resource's log holds no assignment for it`, or
`refused: job <id>'s recorded holder is <did>, not the writer <did>`. The requester is that event's
`requester`.

### Resources

**`yield:create`** records a resource whose content is already in the working tree at `storageUri`.

- A sender holding the worker role must cite its job: `yield:create refused: a worker-role emitter
  must cite the job it fulfils in \`jobId\``. A create that cites a job must name the resource the
  job was assigned on: `yield:create refused: a create citing a job must name the source resource
  its job was assigned on (generatedFrom.resourceId)`.
- A list of generators is refused: `yield:create refused: a multi-agent generator is not supported;
  derivation binds one generator to the executor`.
- The content is registered against the command's checksum.
- The event's payload is `name`, `format`, `contentChecksum`, `contentByteSize`, `storageUri`,
  `entityTypes` (empty when none), `language` when given, `isDraft` (`false` when not given),
  `generatedFrom` when the command names both the source resource and the source annotation,
  `generationPrompt` when given, `generator` when there is one, `creator`, `wasAttributedTo`.
- When the command names both the source resource and the source annotation, the new resource is
  then linked from that annotation: a `mark:update-body` adding a `SpecificResource` whose `source`
  is the new resource, with `purpose` `linking`. The reply does not wait for it.

**`yield:clone-persist`** records a copy: as `yield:create`, without the job rules and with
`parentResourceId` in place of the generation fields. The requester is the sender.

**`yield:update`** registers the content at `storageUri` and records its checksum and size.

**`yield:mv`** finds the resource at `fromUri` in the storage-uri index, moves the file, and records
`{fromUri, toUri}`. With no resource there: `No resource found for URI: <uri>`.

**`mark:archive`** removes the file at `storageUri`, when the command names one, keeping the file
itself when `keepFile` is set, and records the archive. **`mark:unarchive`** requires the file at
`storageUri`, when the command names one: `Cannot unarchive: file not found at <uri>`.

**`mark:update-entity-types`** carries the resource's current types and the types it should have.
Every type to add must be in the vocabulary: `Entity type not registered: <types>`. Nothing is
recorded when one is not.

### Annotations

An annotation is recorded as sent, with `creator`, `generator` and `wasAttributedTo` set by
[attribution](#attribution). An annotation that arrives with a `creator` is refused: `<channel>
refused: \`creator\` on annotation <id> is derived by the knowledge base, never sent`. One with a
list of generators is refused: `<channel> refused: annotation <id> carries a multi-agent generator;
derivation binds one generator to the executor`.

**`mark:create-request`** carries the parts of an annotation, and the Archivist assembles it: a new
id, `created` and `modified` at the time of assembly, and the request's motivation, target and body.
The target's resource must have content that can be annotated: `"<media type>" cannot be annotated`.
The reply follows the append.

**`mark:commit`** records a batch. An annotation whose id the resource's view already holds is
skipped, so a batch sent twice records once. A sender holding the worker role must cite its job:
`mark:commit refused: a worker-role emitter must cite the job it fulfils in \`jobId\``. The reply's
`persisted` and `annotationIds` are the batch as sent, whether or not each was new.

**`mark:delete`** and **`mark:update-body`** record the removal or the body operations as sent.

**`bind:update-body`** is `mark:update-body` with a reply: `bind:body-updated` once the event is
recorded.

### Vocabulary, people and jobs

**`frame:add-entity-type`** and **`frame:add-tag-schema`** record the type or the schema in the
`__system__` stream.

**`person:profile`** records the sender's name in the `__system__` stream, unless it is the name the
stream last recorded for them.

**`job:start`**, **`job:assign`**, **`job:complete`** and **`job:fail`** record the lifecycle of a
job in the stream of the resource it runs on. Payloads: `job:started` `{jobId, jobType,
annotationId?}`; `job:assigned` `{jobId, jobType, resourceId, holder, requester}`; `job:completed`
`{jobId, jobType, annotationId?, result, attempt?, durability?}`; `job:failed` `{jobId, jobType,
annotationId?, error, attempt?, failureClass?, willRetry?, durability?}`.

### Clone tokens

A clone token lets its holder copy one resource for fifteen minutes. It is `clone_` followed by 32
lowercase hex digits, and is kept in memory: a restart forgets every token.

| Command | Does | Refusals |
|---|---|---|
| `yield:clone-token-requested` `{resourceId}` | Issues a token for a resource whose content is in the working tree. Replies `yield:clone-token-generated` `{token, expiresAt, resource}` | `Resource not found`; `Resource content not found` |
| `yield:clone-resource-requested` `{token}` | Replies `yield:clone-resource-result` `{sourceResource, expiresAt}`. The token stays valid | `Invalid or expired token`; `Token expired`; `Source resource not found` |
| `yield:clone-create` | Records the copy as `yield:clone-persist` does, with the source's entity types, then archives the source when `archiveOriginal` is set and it is not archived. Replies `yield:clone-created` `{resourceId}`. The token is spent | Those of `yield:clone-resource-requested`, and those of `yield:clone-persist` |

Failures are on `yield:clone-token-failed`, `yield:clone-resource-failed` and
`yield:clone-create-failed`.

## Browse

The Archivist answers these reads. Each replies on the channel's `-result`, or on its `-failed` with
`{message}`. Requests are answered concurrently, in no particular order.

**Names.** A reply that mentions people names them from `people.json`: every agent of type `Person`
whose DID has a profile carries that profile's name. If the projection cannot be read, the reply
names no one.

| Request | Answers |
|---|---|
| `browse:resource-requested` `{resourceId}` | `{resource, annotations, entityReferences}` from the view, built from the log if there is none. `entityReferences` are the annotations whose motivation is `linking` and whose body names an entity type. A resource with no events fails with `code` `not-found` and message `Resource not found` |
| `browse:resources-requested` `{archived?, entityType?, offset?, limit?}` | `{resources, total, offset, limit}`: the descriptors that match, newest `dateCreated` first and by id among equals, from `offset` (0 when absent) for `limit` (50 when absent). `total` counts every match |
| `browse:annotations-requested` `{resourceId}` | `{annotations, total}` in the view's order. Without a view: `Resource <id> not found in view storage` |
| `browse:annotation-requested` `{annotationId, resourceId}` | `{annotation, resource, resolvedResource}`: the annotation, its resource's descriptor, and the descriptor of the resource its body links to, if any. `Annotation not found` |
| `browse:annotation-history-requested` `{annotationId, resourceId}` | `{events, total, annotationId, resourceId}`: the resource's events about that annotation, in sequence order. The annotation must be in the view: `Annotation not found` |
| `browse:events-requested` `{resourceId, type?, userId?, limit?}` | `{events, total, resourceId}`: the resource's events in log order, filtered, then the first `limit`. Each event carries `agent`, its sender as an agent |
| `browse:annotation-context-requested` `{annotationId, resourceId, contextBefore?, contextAfter?}` | `{annotation, context: {before, selected, after}, resource}`: the annotation's text and up to `contextBefore` and `contextAfter` characters around it (100 each when absent), counted in UTF-16 code units. Needs a `TextPositionSelector`: `TextPositionSelector required for context`. `Annotation not found`; `Resource not found`; `Resource content not found: no text for this media (not decoded, and no derived text yet)` |
| `browse:anchored-text-requested` `{resourceId}` | The resource's anchored text; see below |
| `browse:entity-types-requested` | `{entityTypes}` from `entitytypes.json` |
| `browse:tag-schemas-requested` | `{tagSchemas}` from `tagschemas.json` |
| `browse:agents-requested` | `{agents}`: the roster; see below |
| `browse:kb-requested` | `{name, domain, gitBranch?}`, the domain and the branch read when asked |
| `browse:directory-requested` `{path, sort?}` | `{path, entries}`: the directories and regular files at a path of the working tree, without names that begin `.`. Sorted by `name` (the default), by `mtime` newest first, or by `annotationCount` highest first. A path outside the root: `path escapes project root`. No such path: `path not found` |

**Anchored text.** The answer is the stored entry for the checksum of the resource's first
representation: the extracted text with each word's place, or the decline. Otherwise:

- `{kind: "unknown"}` when the resource has no view or no checksum.
- With no entry, the Archivist waits up to 15 seconds for the Smelter to say it has settled that
  content (`smelt:settled`, naming the resource and the checksum). If the Smelter skipped it:
  `{kind: "no-map"}`. If it indexed it, the entry is read again. In every other case, the wait
  running out included: `{kind: "not-yet"}`.

The Archivist remembers the latest `smelt:settled` for each resource for five minutes, so a request
that follows the signal does not wait.

**Agents.** The roster lists each agent once, in the order its first role appears: the job types
`reference-annotation`, `highlight-annotation`, `assessment-annotation`, `comment-annotation`,
`tag-annotation`, `generation`, then the actors `gatherer`, `matcher`. An entry is `{agent,
servesJobTypes?}`: the agent is `{"@type": "Software", "@id":
"did:web:<domain>:agents:<provider>:<model>", name: "<provider> <model>", provider, model}`, and
`servesJobTypes` lists the job types it serves, absent for an agent that serves only actors. The
domain is read from the tree when asked.

## Enrichment

A published `mark:added` or `mark:body-updated` carries `annotation` beside its payload: the
annotation as the view holds it once the event is applied. An event whose annotation the view does
not hold is published without one. The line in the log is never enriched.

## Facts

**Every appended event is published on the bus,** on the channel named by its type, to the gateway.
A resource's event is published twice: once with no scope, and once scoped to its resource. A
`__system__` event is published once, with no scope. Facts carry no correlation id.

Events are published one at a time, in the order they were appended; the two publishes of one event
go together. A publish that fails, after the transport's own retries, is logged and not tried again:
the services that follow the facts catch up from the log. The number of events waiting to be
published is reported as a gauge.

## The HTTP surface

The Archivist serves five routes on its port. Every route but `/health` requires `Authorization:
Bearer <token>`: a token of the knowledge base's issuer, for the knowledge base's audience, whose
flat `roles` claim includes `semiont-service`. Every refusal is `401` with body
`{"error":"unauthorized"}` and a `WWW-Authenticate` header: `Bearer error="invalid_token"` when a
token was presented, `Bearer` when none was.

| Route | Answers |
|---|---|
| `GET` `/health` | `200` `{"status":"ok","actors":["stower","browser","cloneTokenManager"]}`. It answers once the Archivist has booted |
| `GET` `/events/{resourceId}`, with `?fromSequence=N` | `200` `{"events": […]}`: the stream's stored events from sequence `N` on, in log order. Empty for a resource with none. `N` must be an integer of at least 1: `400` `{"error":"resourceId path segment and integer fromSequence >= 1 are required"}`. A failed read: `500` `{"error":"event read failed"}` |
| `GET` `/resources/{id}/content` | `200` with the content streamed, and `Content-Type` the media type recorded. No view: `404` `{"error":"Resource not found: <id>","code":"resource"}`. A view with no storage URI: `404` `{"error":"Resource representation not found: no storageUri for <id>","code":"representation"}` |
| `GET` `/resources/{id}/jsonld` | `200`, `Content-Type: application/ld+json; charset=utf-8`: what `browse:resource-requested` answers. `404` `{"error":"Resource not found"}` |
| `POST` `/resources` | Stores content and records it; see below |

Any other request is `404` with no body.

**`POST /resources`** takes `multipart/form-data` with a `file` part and the fields of a
[`ResourceUpload`](../../specs/src/components/schemas/ResourceUpload.json).

1. The `Semiont-Principal` header names who the resource is attributed to; without it: `400`
   `{"error":"Semiont-Principal is required: the record attributes every resource to someone"}`.
   `Semiont-Roles` lists that principal's roles, separated by commas.
2. A body that is not multipart: `400` `{"error":"The body is not multipart/form-data"}`. Fields
   the schema refuses: `400` with the schema's reasons. A `format` whose media type is not one
   Semiont knows: `400` `{"error":"Unsupported media type: <type>"}`. `entityTypes` must be a JSON
   list of names, and `generator` a JSON agent.
3. The file is stored at `storageUri`.
4. With a `cloneToken`, the copy is recorded as `yield:clone-create` does. Otherwise the resource is
   recorded as `yield:create` does, with the principal as the sender.
5. `200` `{"resourceId":"<id>"}`. A record that is refused: `500` `{"error":"<the refusal>"}`.

## Boot and shutdown

The Archivist boots in this order, and a failure at any step ends the process with status 1:

1. Read and validate the configuration document.
2. Sign in: its service account's token at the issuer, exchanged at the gateway for the agent token
   it reaches the bus with, as the software agent `semiont archivist`. The token is renewed before
   it expires.
3. Ask staging whether it can work ([Staging](#staging)).
4. Read `[site] domain`; refuse to start without one.
5. **Rebuild the views from the log,** unless `skipRebuild` is set: replay the `__system__` stream
   into its three projections; then, for every stream, build the view from its events and write it,
   and replay its events into the storage-uri index. A stream that fails is logged and skipped, and
   the rest are rebuilt. Then **reap:** delete every view whose resource has no stream.
6. Start answering commands and browse requests.
7. **Seed the vocabulary:** for each default entity type the `__system__` stream has not recorded —
   `Person`, `Organization`, `Location`, `Event`, `Concept`, `Product`, `Technology`, `Date`,
   `Author` — add it, as the knowledge base itself (`did:web:<domain>`).
8. Subscribe to its channels on the bus, start publishing facts, and serve its HTTP surface.

On `SIGTERM` or `SIGINT` it stops renewing its token, leaves the bus, stops its handlers, closes its
HTTP surface and exits with status 0.

## Telemetry

The Archivist exports as `semiont-archivist`.

| Signal | Name | Meaning |
|---|---|---|
| Span | `actor.stower:<channel>`, `actor.browser:<channel>` | One command or browse request handled |
| Span | `bus.emit:<channel>`, `bus.recv:<channel>` | One frame sent to or received from the gateway |
| Histogram | `semiont.handler.duration` | How long a command or browse request took, by actor and channel |
| Histogram | `semiont.record.append.duration` | How long each step of an append took: `persist`, `materialize`, `enrich`, `publish` |
| Gauge | `semiont.archivist.fact_pump.depth` | Events waiting to be published |
| Histogram | `semiont.git.duration` | How long each git command took, by command |
| Counter | `semiont.git.staging.failures` | Staging degradations, by reason: `index-lock` or `other` |
| Counter | `semiont.bus.sent` | Frames sent to the gateway |

## Known defects

What follows is behaviour as it is, and none of it is a rule of the protocol. A conforming
implementation need not reproduce any of it.

**Appending**

- A command with no `_userId`, a `mark:delete` with no `resourceId`, and any failure while recording
  `person:profile` or a `job:*` command stop the handling of every command channel until the
  process restarts. `/health` goes on answering `ok`.
- Commands on different channels for one resource are not ordered against each other. Two that are
  the first to append to a stream after a restart can be given the same sequence number.
- A sequence number is taken before the line is written; a write that fails leaves a gap.
- After a restart, a stream whose last file is empty or holds no readable line numbers its next
  event 1.
- A last line cut short, with no newline, makes the next event appended unreadable.
- When the views cannot be changed after the line is written, or the annotation cannot be attached,
  the command is answered as failed, the event stays in the log, and it is never published. The
  view then counts later events without it until the next rebuild.
- No command checks that its resource exists: a command naming an unknown id begins a stream for it.
  `mark:delete` does not check that the annotation exists.
- `yield:mv`, `mark:archive` and the upload change the working tree before the event is recorded. A
  record that then fails leaves the tree changed.
- `yield:create` and `yield:clone-persist` record the size the command states, not the size of the
  file. `yield:update` records the command's checksum and size after checking the checksum, and an
  update with no size removes the size recorded.
- `mark:commit` records the annotations before the one it refuses, and replies failed.
- `job:started` does not record the command's `attempt`.
- `yield:mv` has no reply on success, and its failure carries no correlation id. A failed
  `mark:update-body` is not reported outside the Archivist.

**Views and projections**

- The projections and the storage-uri entries are written in place, not by rename; a reader can see
  a partial file.
- The rebuild does not start the projections or the storage-uri index from empty: what the log no
  longer supports stays.
- A resource id of one or two characters is taken for a shard directory: its stream is not rebuilt
  and its view is reaped.
- A directory under `.semiont/events/` whose name is longer than two characters and is not a
  resource id, or a view file that is JSON but has no `resource`, stops the boot.
- When two resources have been at one storage URI, the index entry after a rebuild depends on the
  order directories are listed. `yield:moved` removes the entry for `fromUri` whichever resource it
  names.
- `browse:resource-requested` writes a view when it builds one, unordered against an append to the
  same resource.
- The sort of `entitytypes.json` and `tagschemas.json` depends on the locale of the process.
- The vocabulary seeded at the first boot is recorded before facts are published, and is never
  published.

**The working tree and staging**

- A storage URI is not confined to the working tree: `file://../x` names a file outside it.
- The upload replaces a file already at the URI before the record is made, and leaves the new bytes
  when the record is refused. A store that fails answers `500` `{"error":"internal error"}`.
- The upload is held in memory whole before it is written. No size is refused.
- Nothing pending is staged at shutdown.

**Browse and the HTTP surface**

- `browse:directory-requested` reports a file as a resource's only when the resource's storage URI
  is the file's absolute path; storage URIs are relative to the root, so files are reported as
  untracked. A failure after the directory is read is not answered.
- Only `browse:resource-requested` gives `not-found` as a `code`; the other reads give the message
  alone.
- `browse:events-requested` reads a `limit` of 0 as no limit, and its `total` counts after the
  limit.
- A history cannot be read for an annotation that has been removed.
- A resource id that fails the id rule, or a path that is not validly percent-encoded, is answered
  `500` `{"error":"internal error"}`.
- `fromSequence` accepts whatever JavaScript reads as an integer, `1e2` and `0x10` among them.
- Content carries no `Content-Length` and no range support. A file missing from the tree closes the
  connection after a `200`.
- Replies to requests the Archivist makes of itself are also sent to the gateway.

**Clone tokens**

- Two `yield:clone-create` commands sent together with one token both succeed. A token never
  presented is never forgotten until a restart.
- Archiving the source of a clone does not remove its file, and the reply does not wait for it.
