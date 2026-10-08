# Channel inventory

Every channel on the bus, by what kind of channel it is. The rules behind the kinds (naming, identity, correlation, delivery) are in [EVENT-BUS.md](./EVENT-BUS.md).

The authority is [`specs/src/bus/registry.json`](../../specs/src/bus/registry.json). It declares every channel, the payload it carries, and the class it belongs to, and each SDK's channel tables are generated from it. Where this page and the registry disagree, the registry is right.

## How a channel is classed

Every channel belongs to exactly one of these, and the generators refuse a channel that names none:

| Class | What it is | Who receives it |
|---|---|---|
| **Operation** | A request with a result and a failure | The request reaches the one service that answers it. The reply reaches the client that asked |
| **Command** | A directive with no reply | The one handler that owns it |
| **Event** | A fact announced after it happened | Set by its audience: **everyone**, the clients viewing one resource (**scoped**), or the services that name it (**declared**) |
| **In-process** | A signal on a client's or a service's own bus | Nobody else. It never crosses the wire |

Two more facts are declared beside the class:

- **Recorded.** Whether the channel is an event of the record, appended to the event log.
- **Effect.** For a channel a client can emit: whether emitting it **writes** to the knowledge base or only **reads** from it.

## Events of the record

These are appended to the event log. Everything else on this page is transient.

| Family | Channels | Delivered to |
|---|---|---|
| Resources | `yield:created`, `yield:cloned`, `yield:updated`, `yield:moved` | everyone |
| Renditions | `yield:representation-added`, `yield:representation-removed` | the resource's viewers |
| Annotations | `mark:added`, `mark:removed`, `mark:body-updated` | the resource's viewers |
| A resource's own facts | `mark:entity-tag-added`, `mark:entity-tag-removed`, `mark:archived`, `mark:unarchived` | the resource's viewers |
| Vocabulary | `frame:entity-type-added`, `frame:tag-schema-added` | everyone |
| Jobs | `job:started`, `job:assigned`, `job:completed`, `job:failed` | the resource's viewers |
| People | `person:profiled` | the services that name it |

`mark:added` and `mark:body-updated` are delivered with the annotation as it stands, so a client holding it updates in place.

## Events that are not recorded

| Channels | Says | Delivered to |
|---|---|---|
| `job:report-progress`, `job:complete`, `job:fail` | What a worker reports about a job | everyone; a consumer filters by the job's id or the resource's |
| `job:queued` | A job is waiting to be claimed | workers |
| `beckon:focus`, `beckon:sparkle` | Look here | everyone |
| `browse:resource-open`, `browse:click` | Open this | everyone |
| `browse:resource-viewed` | A viewer arrived at a resource | everyone |
| `session:joined`, `session:left` | A participant connected or disconnected | everyone |
| `smelt:settled` | A resource's text has been indexed | everyone |
| `weave:applied` | An event has been applied to the graph | the services that name it |
| `mark:body-update-failed` | A body update could not be recorded | the services that name it |
| `bus:resume-gap` | A stream resumed past events it could not replay | everyone |

## Commands

Directives with no reply, each owned by one handler: `job:start`, `job:assign`, `job:checkpoint`, `job:cancel`, `mark:update-body` and `person:profile`.

## Operations

A request, answered on its result or its failure channel. The reply reaches only the client that asked, matched by the correlation id on the frame's envelope.

| Family | Requests | Effect |
|---|---|---|
| Yield | `yield:create`, `yield:update`, `yield:clone-create`, `yield:clone-persist` | writes |
| Yield | `yield:clone-token-requested`, `yield:clone-resource-requested` | reads |
| Mark | `mark:create-request`, `mark:commit`, `mark:delete`, `mark:archive`, `mark:unarchive`, `mark:update-entity-types` | writes |
| Bind | `bind:update-body` | writes |
| Frame | `frame:add-entity-type`, `frame:add-tag-schema` | writes |
| Browse | every `browse:…-requested` | reads |
| Match | `match:search-requested`, `match:resources-requested`, `match:limits-requested` | reads |
| Gather | `gather:requested`, `gather:resource-requested`, `gather:referenced-by-requested`, `gather:summary-requested`, `gather:limits-requested` | reads |
| Jobs | `job:create`, `job:claim`, `job:cancel-requested` | writes |
| Jobs | `job:status-requested`, `job:limits-requested` | reads |
| Rebuilds | `weave:rebuild`, `smelt:rebuild-anchors` | writes |

Each request's result and failure channels are named in the registry's `operations`. Most follow one pattern: `-requested` answers on `-result` and `-failed`, and a command answers on `-ok` and `-failed`.

## In-process channels

Published on a client's own bus only. They are the Browser's interface: `nav:*`, `panel:*`, `tabs:*`, `shell:*`, `settings:*`, `beckon:hover`, `browse:entity-type-clicked`, `yield:clone`, and the `mark:` and `bind:` signals that coordinate one viewer's annotation interface. See [react-ui's event internals](../../packages/react-ui/docs/EVENTS.md).

## See also

- [EVENT-BUS.md](./EVENT-BUS.md): naming, identity, correlation, scoping and delivery
- [The eight verbs](./flows/README.md): what each family of channels is for
- [JOBS.md](./JOBS.md): the job channels and what the dispatcher does with each
- [TRANSPORT-CONTRACT.md](./TRANSPORT-CONTRACT.md): what a transport promises about delivery
- [`specs/src/bus/registry.json`](../../specs/src/bus/registry.json): the authority
