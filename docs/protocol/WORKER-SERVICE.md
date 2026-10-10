# Worker Service

What the Worker service does: the process a worker image runs. It is a worker
in the sense of [WORKER-CONTRACT.md](./WORKER-CONTRACT.md), and keeps that
contract; this document is everything else it does. How it is configured and
what it refuses to start on, the agents it works as, what it reads for a job,
what it asks its model and what it does with the answer, what it commits and
reports, how it ends a job, and how it stops. What the dispatcher does with a
worker's messages is [JOBS.md](./JOBS.md), and what the record does with them
is [ARCHIVIST.md](./ARCHIVIST.md).

A Worker service written in another language does what is written here. If
the code deviates from it, the code is wrong, or this document is wrong and is
corrected deliberately. There is no third option.

**How this document is held.** Each rule ends with *Held by* and the case of
the worker-service conformance suite
([`tests/conformance/worker-service`](../../tests/conformance/worker-service/README.md))
that fails when a Worker service breaks it: `worker-service/<case>` is the
file `<case>.test.ts` there. The suite starts the service as a process and
meets it only at its boundary, so the same cases judge every implementation. A
rule marked "Held by no case" is one nothing checks.
`npm run lint:transport-contract` fails when a case named here does not exist,
and when a case of the suite is named by no rule.

**What this document does not cover.** A `yield` job to PDF, and so the
citations of a generated PDF; and the budget of an Anthropic model whose
`contextTokens` leave 64 tokens or fewer to read once its `maxOutputTokens`
and the prompt are taken from them.

**What an offset counts.** An offset into a text counts Unicode code points
from the start of the text, exactly as it was decoded
([W3C-SELECTORS.md](./W3C-SELECTORS.md)), and so does every length a rule below
states: the size of a piece, a cursor, the context around a span, the tokens
of a prompt. A character outside the Basic Multilingual Plane is one code
point, where a string of UTF-16 code units has two for it.
[`specs/src/text/offset-cases.json`](../../specs/src/text/offset-cases.json)
holds the count.

## Configuration

- **B1.** A Worker service reads one document, a
  [`WorkerConfig`](../../specs/src/components/schemas/WorkerConfig.json),
  from the path its `--config` flag names: `--config <path>` or
  `--config=<path>`. It defaults nothing the document leaves out, and reads no
  other configuration. Started without the flag, or with no path after it, it
  writes `[fatal] The worker's configuration document is not named: start it
  with --config <path>` to stderr and exits with status 1.
  *Held by `worker-service/boot`.*
- **B2.** A path that names no file, a file that is not JSON, and a document
  the schema refuses are each refused the same way: one line on stderr that
  begins `[fatal] ` and names the path, and exit status 1. For a file that
  cannot be read the line begins `[fatal] Cannot read the worker's
  configuration document at <path>`; for one that is not JSON, `[fatal] <path>
  is not JSON:`; for one the schema refuses, `[fatal] <path> is not a worker
  configuration document (WorkerConfig):`, followed by one line for each
  reason, indented by two spaces. A required member that is absent is the
  reason `Missing required property: <member>`. A reason names a member and
  what was expected of it, and never a value found in the document.
  *Held by `worker-service/boot`.*
- **B3.** The document carries no secret. The service's own account at the
  issuer is `SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET` in its
  environment. With either unset or empty it writes `[fatal] <variable> is not
  set in the worker's environment: a worker signs in as a service account` and
  exits with status 1. Nothing it writes carries the secret.
  *Held by `worker-service/boot`.*
- **B4.** A provider's key is named, not stated: an agent's `apiKeyEnv` is the
  name of the environment variable that holds it. When the variable an agent
  names is unset or empty, the service writes `[fatal]
  agents[<index>].apiKeyEnv names a variable that is not set in the worker's
  environment` and exits with status 1. The line says which member named the
  variable and never what it named: a key written where the name belongs is a
  value found in the document, and nothing the service writes carries it.
  *Held by `worker-service/boot`.*
- **B5.** All of the above is settled before anything is dialled. A service
  that refuses to start has asked nothing of the issuer, the gateway or a
  provider.
  *Held by `worker-service/boot`.*
- **B6.** Whatever ends a service with status 1 before its health answers is
  said as the refusals above are: one line on stderr that begins `[fatal] `
  and says why. A service whose sign-in the issuer refuses ends so, and so
  does one that cannot listen on its `port`; the health of neither ever
  answers. Nothing either writes carries the secret.
  *Held by `worker-service/boot`.*

## Agents

A Worker service works as one **agent** for each entry of its document's
`agents`: a provider and a model, the jobs that pair serves, and where the
provider is reached. Each agent is a worker of its own under
[WORKER-CONTRACT.md](./WORKER-CONTRACT.md): it holds one job at a time, and the
agents of one service work at once.

- **G1.** For each entry, the service signs in as that agent: it is granted a
  token for its service account at the issuer the document names, and
  exchanges it at the gateway, `POST /api/tokens/agent` with the entry's
  `provider` and `model`, for the agent's token. The DID the gateway answers
  is the agent's identity. The service uses it as answered, and derives it
  from nothing else.
  *Held by `worker-service/started`.*
- **G2.** Each agent opens one stream of its own. It names what a worker's
  stream names ([WORKER-CONTRACT S1](./WORKER-CONTRACT.md#the-stream)): the
  reply channels of `job:claim`, of `mark:commit` and
  `browse:annotation-requested`, and of `browse:resource-requested` and
  `browse:anchored-text-requested`; and the broadcasts `job:queued` and
  `job:cancel-requested`. The first agent's also names `job:limits-requested`
  ([Limits](#limits)). No stream names a scope.
  *Held by `worker-service/started`.*
- **G3.** Each agent claims with its own entry's `accepts`, as given, and with
  no other filter.
  *Held by `worker-service/started`.*
- **G4.** A job is run by the agent that claimed it: on that agent's provider
  and model, with every message about the job sent under that agent's token.
  What the job makes states that agent as its `generator`: `@type`
  `Software`, `@id` the agent's DID, `name` the provider and the model with a
  space between, and `provider` and `model`.
  *Held by `worker-service/started`.*

## Health

- **H1.** The service answers `GET /health` on the document's `port`, with no
  token asked, once every agent has signed in: `200`, `application/json`, and
  `{"status": "ok", "agents": <count>, "workers": [...]}`. `workers` has one
  entry for each agent, in the order of the document: its `provider`,
  `model` and `did`, the filters it `serves`, and what a worker can say of
  itself ([WORKER-CONTRACT V1](./WORKER-CONTRACT.md#liveness)):
  `lastQueuedEventAt`, `lastClaimAt`, `lastFinishedAt` and `lastActivityAt`,
  each an instant or `null`; `activeJob`, `null` or the held job's `jobId`,
  `type` and `since`; and `jobsCompleted`. The path is matched without its
  query string: `GET /health?probe=1` is answered as `GET /health` is. A
  request of any other path, and a request of `/health` by any other method,
  is answered `404` with no body.
  *Held by `worker-service/started`.*

## Limits

A Worker service holds the keys to its providers, so it is what can say what
each of its models can take.

- **M1.** The first agent answers `job:limits-requested` with one
  `job:limits-result`, carrying the request's correlation id: `limits`, an
  entry for each distinct provider and model among the agents, in the order
  of the document, each with `contextTokens`, `maxOutputTokens` and
  `acceptsTemperature`. No other agent answers.
  *Held by `worker-service/limits`.*
- **M2.** An Ollama model's limits are asked of its provider: `POST
  <baseUrl>/api/show` with `{"model": <model>}`. The context length is the
  member of `model_info` named `<architecture>.context_length`, where
  `<architecture>` is `model_info`'s `general.architecture`, or failing that
  any member whose name ends `.context_length`. It is stated as both
  `contextTokens` and `maxOutputTokens`: what goes in and what comes out share
  one window. `acceptsTemperature` is `true`.
  *Held by `worker-service/limits`.*
- **M3.** An agent asks for its model's limits once, when they are first
  needed, and keeps the answer. An answer it could not get is not kept: that
  model is left out of the reply, the request is still answered, and the
  provider is asked again the next time the limits are needed.
  *Held by `worker-service/limits`.*
- **M4.** A provider that has not answered within 1.5 seconds is left out of
  that reply.
  *Held by no case.*
- **M5.** An Anthropic model's limits are asked of its provider in two
  requests. Each carries the agent's key ([B4](#configuration)) as
  `x-api-key`, and `anthropic-version: 2023-06-01`, as every request of an
  Anthropic agent does. The first is `GET <baseUrl>/v1/models/<model>`: its
  `max_input_tokens` is stated as `contextTokens` and its `max_tokens` as
  `maxOutputTokens`, each a ceiling of its own. The second is a probe, `POST
  <baseUrl>/v1/messages` with `model`, a `max_tokens` of 1, a `temperature`
  of 0.7 and one message, `{"role": "user", "content": "ok"}`:
  `acceptsTemperature` is `true` when it is answered, and `false` when it is
  refused with 400 in words that name `temperature`. The two are one asking
  under [M3](#limits): neither is made again once both are had, and any other
  refusal of either is an answer that could not be got.
  *Held by `worker-service/limits`, `worker-service/anthropic`.*

## What a job reads

- **J1.** A held job's first message is its `job:start`
  ([WORKER-CONTRACT L1](./WORKER-CONTRACT.md#the-lifecycle)). For a `mark` job
  the service then reads the resource's description on the bus:
  `browse:resource-requested` with the job's `resourceId`. The resource's
  media type is the `mediaType` of the description's first representation.
  *Held by `worker-service/highlighting`.*
- **J2.** Where the text comes from follows the media type's `textSource` in
  the [media-type registry](../../specs/src/media-types/registry.json). For
  `decode`, the text is the resource's bytes, read from the gateway (`GET
  /resources/{id}`, under the agent's token) and decoded. For
  `pdf-text-layer`, the text is the Smelter's, asked for on the bus
  (`browse:anchored-text-requested` with the `resourceId`), and the service
  reads no bytes. For `none`, the job is not done ([N3](#declines)).
  *Held by `worker-service/highlighting`, `worker-service/pdf`, `worker-service/declines`.*
- **J3.** A `yield` job reads nothing. Everything it knows of its source is
  the context in the job.
  *Held by `worker-service/yield`.*

## Detection

A `mark` job is a **detection**: the service asks its model for spans of the
resource's text, anchors each in the text, and commits an annotation for each.
A job's work is divided into **units**, the grain it checkpoints at. A
highlighting, commenting or assessing job is one unit, named by its
motivation; a linking job is one unit for each of its `entityTypes`; a tagging
job is one unit for each of its `categories`.

### The request

- **D1.** On an Ollama agent a generation is `POST <baseUrl>/api/generate`
  with `model`, `prompt`, `stream: false`, `think: false`, `options`
  (`num_predict`, `num_ctx` and `temperature`), and, when the answer is to be
  an array of objects, `format`: `{"type": "array", "items": <schema>}`.
  Nothing else is sent. Before an agent's first generation it asks its
  model's limits ([M2](#limits)).
  *Held by `worker-service/highlighting`.*
- **D2.** A detection's `temperature` is `0`. Its prompt is the kind's
  ([The five kinds of mark job](#the-five-kinds-of-mark-job)), carrying one
  piece of the text.
  *Held by `worker-service/highlighting`, `worker-service/prompts`.*
- **D3.** The token budget is worked out from the model's window and the
  prompt, and from nothing about the text. A text of `n` code points is
  `ceil(n / 4)` tokens. With `C` the model's `contextTokens` and `S` the
  tokens of the prompt around an empty text: `available = C − S`; `input =
  floor(available / 3)`; `output = available − input`. When `output` is over
  9000, `input` becomes `floor(input × 9000 / output)` and `output` becomes
  9000. Then `input` is the lesser of itself and `floor(output / 2)`. An
  `input` of 64 or less fails the job as deterministic, with nothing asked of
  the model: the window is too small, and is as small on every attempt.
  `num_predict` is `output`. With `P` the
  tokens of the whole prompt, `num_ctx` is the lesser of `C` and `P +
  num_predict + ceil(P × 0.2) + 64`.
  *Held by `worker-service/highlighting`, `worker-service/chunks`, `worker-service/prompts`, `worker-service/code-points`, `worker-service/failures`.*
- **D20.** On an Anthropic agent a generation is `POST <baseUrl>/v1/messages`
  with `model`, `max_tokens`, `temperature`, `messages` (one message, of
  `role` `user`, whose `content` is the prompt), and, when the answer is to
  be an array of objects, `output_config`: `{"format": {"type":
  "json_schema", "schema": {"type": "array", "items": <schema>}}}`. Nothing
  else is sent, but `stream` by a long generation
  ([Y9](#generation)). A model that takes no temperature
  ([M5](#limits)) is sent none. The answer is the text of the message, and
  why the model stopped is its `stop_reason`. Before an agent's first
  generation it asks its model's limits ([M5](#limits)). A model that does
  not report `capabilities.structured_outputs.supported` as `true` is not
  asked for an array of objects: a job that needs one fails with no
  generation asked for, and its error names the model.
  *Held by `worker-service/anthropic`.*
- **D21.** On an Anthropic agent the budget of [D3](#the-request) is worked
  out from the model's two ceilings. With `M` its `maxOutputTokens`: `output
  = M`, and `input = C − M − S`. When `output` is over 10666, `input` becomes
  `floor(input × 10666 / output)` and `output` becomes 10666. That is what a
  model writes in five minutes at 128,000 tokens an hour, the rate
  Anthropic's library reckons by; the 9000 of [D3](#the-request) is the same
  at 108,000, the rate taken of a provider that states none. Then `input` is
  the lesser of itself and `floor(output / 2)`. `max_tokens` is `output`, and
  there is no `num_ctx`.
  *Held by `worker-service/anthropic`.*

### Pieces

- **D4.** The text is asked about a piece at a time. A piece is at most `size
  × 4` code points, and `size` opens at `input`. Cut from `at`, a piece ends at
  `at + size × 4` or the end of the text, whichever comes first. When that is
  short of the end of the text, the piece is ended earlier: at the last
  paragraph break (two line ends) at or before it, or failing that just after
  the last full stop followed by a space, or failing that at the last space.
  A break counts only when it is more than `size × 2` code points past `at`,
  and with none that does the piece is not shortened. The prompt carries the
  piece with the white space at its ends taken off. The next piece starts 256
  code points before this one ended, so that a span at the cut is seen whole by
  one of the two, or where this one ended when that would be no further on
  than this one started. A piece that reaches the end of the text is the last.
  *Held by `worker-service/chunks`, `worker-service/code-points`.*
- **D5.** A span two pieces both see is one annotation. Two proposals alike in
  motivation, place and body are counted twice as found and committed once:
  within a job for highlighting, commenting, assessing and tagging, and within
  an entity type for linking.
  *Held by `worker-service/chunks`, `worker-service/assessing`, `worker-service/code-points`.*
- **D6.** `size` holds from piece to piece when the provider reports no token
  usage.
  *Held by `worker-service/chunks`.*
- **D7.** When the provider reports usage, `size` follows it: a piece whose
  answer used less than half of `output` makes the next piece half as large
  again, and one that used more than eight tenths makes it seven tenths the
  size. `size` is never under the lesser of `input` and 128, nor over the
  greater of `input` and `C − S − output`.
  *Held by no case.*

### Anchoring

- **D8.** The model is asked for the text of each span, `exact`, and for what
  stands before and after it, and never for an offset. The service finds
  `exact` in the whole text. Found once, the span is there. Found more than
  once, it is the first occurrence whose surroundings carry the model's
  `prefix` and `suffix`, and the first occurrence of all when none does or the
  model gave neither. A `prefix` or `suffix` that is empty or only white space
  is not given. Found nowhere, `exact` is looked for again, three ways in
  turn: without regard to white space or to the form of quotation marks and
  dashes; without regard to letter case; and as the stretch of the text the
  fewest edits from it. The first two may find several places, and the
  model's `prefix` and `suffix` choose among them as they do among
  occurrences. For the third an edit is one code point inserted, deleted or
  replaced, and the most allowed is one for every twenty code points of
  `exact`, rounded down, with no minimum: an `exact` of fewer than twenty code
  points is allowed none. The stretch may be longer or shorter than `exact`
  by as much as is allowed, and of several the fewest edits away it is the
  first in the text; of those that begin at the same place, the one nearest
  `exact` in length, and of two as near the shorter. The span is the text's
  own words, never the model's spelling of them. An `exact` that is empty or
  only white space, or that none of these finds, is no span: the proposal
  makes no annotation, and is counted in the job's `found` and in its `errors`
  ([D15](#committing-and-where-a-job-stands)). A proposal that is not an
  object with a string `exact`, and the other members its kind requires, is
  no proposal: it is neither committed nor counted.
  *Held by `worker-service/highlighting`, `worker-service/linking`, `worker-service/commenting`, `worker-service/anchoring`, `specs/src/annotations/reconcile-cases.json`.*
- **D9.** A span on text is anchored by two selectors: a
  `TextPositionSelector`, the offsets of its first code point and of the one
  after its last; and a `TextQuoteSelector`, its `exact`, with `prefix` and
  `suffix`. Those two are the text's own and never the model's: the 64 code
  points before the span and the 64 after, each extended by up to 32 more
  until the character beyond is white space or one of ``. , ; : ! ? ' " ( )
  [ ] { } < > / \``. A span at the start of the text has no `prefix`, and one
  at its end no `suffix`.
  *Held by `worker-service/highlighting`, `worker-service/commenting`, `worker-service/tagging`, `worker-service/code-points`.*
- **D10.** A span of a PDF is anchored by where its text is on the page, and
  by no offset: one `FragmentSelector` for each line it is on, top line first,
  `conformsTo` `http://tools.ietf.org/rfc/rfc3778`, with the value
  `page=<page>&viewrect=<x>,<y>,<width>,<height>`; and then the
  `TextQuoteSelector` of [D9](#anchoring). The Smelter's answer gives each run
  of the text its page and rectangle. Runs of one page whose `y` is within 2
  points of the line's first run are one line. A line's rectangle spans the
  runs the span touches, a run the span covers only part of counted in
  proportion to the code points covered; its `y` is the lowest of the runs',
  and its height reaches the highest top.
  *Held by `worker-service/pdf`.*

### The annotation

- **D11.** An annotation a detection commits has `@context`
  `http://www.w3.org/ns/anno.jsonld`, `type` `Annotation`, its `id`, its
  `motivation`, the agent as `generator` ([G4](#agents)), `created`, a
  `target` of `type` `SpecificResource` with the resource as `source` and the
  span's `selector`, and the `body` of its kind, when its kind has one. It
  states no `creator`: who asked for the job is the record's to say. It
  states no `modified`: `created` is the moment it was built, and what
  becomes of it afterwards is the record's to say too. It is the annotation
  of a span that
  [`builder-cases.json`](../../specs/src/annotations/builder-cases.json)
  states, as every SDK's `annotationOfSpan` builds one.
  *Held by `worker-service/highlighting`, `specs/src/annotations/builder-cases.json`.*
- **D12.** Its `id` is what the annotation is, hashed
  ([WORKER-CONTRACT A2](./WORKER-CONTRACT.md#committing-annotations)): the
  first 21 characters of the base64url SHA-256 of the canonical JSON of
  `resourceId`, `motivation`, `anchor` and, when the annotation has one,
  `body`. `anchor` is `<start>:<end>:<exact>`, the span's offsets in the text
  the model was asked about, in code points, for a PDF as for any other.
  Canonical JSON has the members of every object in order of their names by
  code point, arrays in their own order, and no white space
  ([`id-cases.json`](../../specs/src/annotations/id-cases.json)).
  *Held by `worker-service/highlighting`, `worker-service/commenting`, `worker-service/assessing`, `worker-service/linking`, `worker-service/tagging`, `worker-service/pdf`, `worker-service/code-points`.*

### Committing, and where a job stands

- **D13.** The annotations of each piece are committed as one batch, through
  the held job ([WORKER-CONTRACT A1, A4 to
  A6](./WORKER-CONTRACT.md#committing-annotations)), in the order the model
  proposed them. Once the batch is established the service emits
  `job:checkpoint`, with the cursor of every unit the job has begun, finished
  or not: each as the job was claimed with it
  ([WORKER-CONTRACT R2](./WORKER-CONTRACT.md#the-claimed-record)), until this
  attempt establishes a batch of that unit, and from then where this attempt
  has taken it. A unit's cursor is `next`, the offset its next piece starts at,
  or the length of the text after its last, in code points; `size`, the size
  its last piece was cut at; and its `found`, `emitted` and `errors` so far.
  Only then is the next piece asked about. A piece with nothing to commit
  commits nothing and is checkpointed all the same.
  *Held by `worker-service/highlighting`, `worker-service/chunks`, `worker-service/code-points`, `worker-service/linking`, `worker-service/resume`.*
- **D14.** A linking job's checkpoints also state the entity types this
  attempt has finished, in `completedUnits`: when a type's last batch is
  established, a checkpoint names the type as finished, and carries its
  cursor still, as every checkpoint after it does. A finished type's cursor is
  where the type ended: `next` at the length of the text, and its final
  counts. The units of a job of any other motivation are never named as
  finished in a checkpoint. One whose cursor stands at the length of the text
  has nothing left to ask about, and is counted by that cursor as any unit is
  ([U1](#resuming)).
  *Held by `worker-service/linking`, `worker-service/tagging`, `worker-service/resume`.*
- **D15.** A `mark` job's result is its counts. `found` is the proposals the
  model made; `persisted`, the annotations committed; `errors`, the proposals
  that made no annotation, stated only when there are any: those whose text
  is nowhere in the resource and, in a linking job, those of another entity
  type than the one asked for ([K4](#the-five-kinds-of-mark-job)). A
  tagging job adds `byCategory`, the annotations committed for each category
  that has any. The counts are the whole job's, over every attempt: a unit an
  earlier attempt finished, or left partway, is counted by its cursor
  ([U1 and U2](#resuming)). The completion states how the job's commits were
  established
  ([WORKER-CONTRACT A6](./WORKER-CONTRACT.md#committing-annotations)).
  *Held by `worker-service/highlighting`, `worker-service/tagging`, `worker-service/linking`, `worker-service/resume`.*

### Progress

- **D16.** A job reports where it stands with `job:report-progress`
  ([WORKER-CONTRACT L2](./WORKER-CONTRACT.md#the-lifecycle)): a `percentage`,
  and a `message` that is a code with its values, never a sentence. The
  service does not wait for the gateway to take a report before it goes on,
  so the order in which reports and the messages around them arrive is not
  fixed; what is fixed is which reports are made, and how many times.
  *Held by `worker-service/highlighting`.*
- **D17.** A highlighting, commenting or assessing job reports `loading` at
  10 and `analyzing` at 30; after each piece, `creating-annotations` at 60
  with the count of annotations made so far, and, when text remains, `analyzing` at `30
  + round(30 × next / length)`, the cursor's `next` over the text's length,
  both in code points; and at the end `complete-created` at 100 with the count
  and the motivation. Every report repeats what the job was asked
  with, as `requestParams`: its `instructions`, its `tone` and its `density`,
  those it has, in that order.
  *Held by `worker-service/highlighting`, `worker-service/chunks`, `worker-service/commenting`, `worker-service/assessing`, `worker-service/code-points`.*
- **D18.** A linking job reports `loading` at 10, and then
  `detecting-entities`, naming the entity type, at `20 + round(60 × finished /
  types)`: when a type is begun, when its mentions have been counted, when a
  piece's batch is established, and when the type is finished. Each states the
  type it is on (`current`), the types finished and their number
  (`processed`, `total`, `completedItems` with each type's `foundCount` and
  `persistedCount`), and the job's `entitiesFound`, `entitiesEmitted` and,
  once any count has been made, `entitiesExpected`. It ends with
  `complete-created` at 100. Every report carries `requestParams`: the entity
  types, as one string. The types are every entity type of the job, and the
  finished are those of every attempt: `total` and `requestParams` are of the
  whole job, and a type an earlier attempt finished is among the finished
  from the first report, in `processed`, `completedItems`, `entitiesFound` and
  `entitiesEmitted` ([U2](#resuming)).
  *Held by `worker-service/linking`, `worker-service/resume`.*
- **D19.** A tagging job reports `loading` at 10 and `analyzing-tags` at 30;
  for each category, `analyzing-tags` at `30 + round(30 × index / categories)`
  with the category, its index and the categories finished; after each piece,
  `creating-tag-annotations` at 60 with the count of annotations made so far;
  and at the end `complete-created` at 100.
  *Held by `worker-service/tagging`.*

## The five kinds of mark job

The prompt each kind sends is kept, as the text sent, beside the suite in
[`tests/conformance/worker-service/prompts`](../../tests/conformance/worker-service/prompts).
A job's `sourceLanguage` is said in the prompt by its English name; so is the
`language` its text is to be written in, unless that is English.

- **K1.** A **highlighting** job asks for an array of `exact`, `prefix` and
  `suffix`, `exact` required. Its prompt follows the job's `instructions` and
  `density` when it has `instructions`, and asks for what is important in the
  text when it has none. A highlight has no body.
  *Held by `worker-service/highlighting`, `worker-service/prompts`.*
- **K2.** A **commenting** job asks for the same and a `comment`, `exact` and
  `comment` required. Its prompt follows the job's `instructions`, `tone` and
  `density`, or asks for comments that explain. A proposal whose comment is
  blank is no proposal. A comment's body is a list of one `TextualBody`: the
  comment as `value`, `purpose` `commenting`, `format` `text/plain`, and
  `language` the job's, or `en` when it has none.
  *Held by `worker-service/commenting`, `worker-service/prompts`.*
- **K3.** An **assessing** job asks for the same and an `assessment`, `exact`
  and `assessment` required. Its prompt follows the job's `instructions`,
  `tone` and `density`, or asks for assessments that evaluate. A proposal
  whose assessment is blank is no proposal. An assessment's body is one
  `TextualBody`, not a list: the assessment as `value`, `purpose`
  `assessing`, `format` `text/plain`, and `language` as for a comment.
  *Held by `worker-service/assessing`, `worker-service/prompts`.*
- **K4.** A **linking** job takes its entity types one at a time, in the
  job's order, on an Ollama model, and four at a time on an Anthropic one
  ([K8](#the-five-kinds-of-mark-job)). For each piece it makes two generations:
  the extraction, an array of `exact`, `entityType`, `prefix` and `suffix`
  with the first two required, asking for names only unless the job has
  `includeDescriptiveReferences`; and a count of the mentions in the same
  piece, a prompt with no `format`, a `num_predict` of 16, and an answer read
  as the first whole number in it, through its thousands separators (`1,234`
  is 1234). A mention whose `entityType` is not, character for character, the
  type being asked for makes no annotation, and is counted in the job's
  `found` and `errors`. A reference's body is a list of one
  `TextualBody`: the entity type as `value`, `purpose` `tagging`, `format`
  `text/plain`, and `language` as for a comment.
  *Held by `worker-service/linking`, `worker-service/prompts`.*
- **K5.** An extraction that found fewer than half of what the count reports
  is taken to have missed mentions. Over a piece that cannot be cut smaller,
  what was found is kept and committed all the same: the job's result counts
  the piece in `underReportedPieces`, and its reports state, with the entity
  type among the finished, the pieces kept so, what they found and what was
  counted (`underReported`).
  *Held by `worker-service/linking`.*
- **K6.** Over a piece that can be cut smaller, an extraction taken to have
  missed mentions is asked again in halves instead, as a piece whose answer
  was cut off is ([F6](#failures)). A count that fails, or answers no number,
  checks nothing.
  *Held by no case.*
- **K7.** A **tagging** job takes its `categories` one at a time, in the
  job's order, each over the whole text. Its prompt states the schema the
  dispatcher handed over with the job (its `name`, `description` and
  `domain`) and the category (its name, `description` and `examples`), and
  asks for an array of `exact`, `prefix` and `suffix`, `exact` required. A
  tag's body is a list of two `TextualBody`: the category as `value`,
  `purpose` `tagging`, `format` `text/plain` and `language` as for a comment;
  and the schema's `id` as `value`, `purpose` `classifying` and `format`
  `text/plain`.
  *Held by `worker-service/tagging`, `worker-service/prompts`.*
- **K8.** On an Anthropic agent a linking job has up to four of its entity
  types with the model at once: the job's first four, and each of the others
  when one before it is finished. Each type is done as
  [K4](#the-five-kinds-of-mark-job) says, its count a generation with no
  `output_config` and a `max_tokens` of 16. So what the job asks its model,
  commits and checkpoints comes in no fixed order across its types.
  *Held by `worker-service/anthropic`.*

## Declines

A job the service will not do ends one of two ways. A resource with nothing to
read is **declined**: the job completes, and its result says why. A resource
that can never be read, and a job the service cannot run, **fail** as
deterministic, so that no attempt is spent on them again.

- **N1.** A `mark` job on a text that is empty, or nothing but white space,
  completes with the result `{"declined": true, "reason": "empty"}`. Nothing
  is asked of the model, nothing is committed, and no progress is reported.
  *Held by `worker-service/declines`, `worker-service/pdf`.*
- **N2.** A `mark` job on a PDF the Smelter declined completes declined, with
  the Smelter's reason: `encrypted`, `corrupt`, `no-text-layer` or
  `too-large`.
  *Held by `worker-service/pdf`.*
- **N3.** A `mark` job on a resource whose media type has no text fails as
  deterministic. The error names the job, the resource and the media type. No
  bytes are read.
  *Held by `worker-service/declines`.*
- **N4.** A `mark` job on a PDF whose text the Smelter has not settled
  (`not-yet`) fails with no class, so that a later attempt may find it. The
  service asks once, and does not wait.
  *Held by `worker-service/pdf`.*
- **N5.** A `mark` job on a PDF the Smelter has no map of (`no-map`) or does
  not know (`unknown`) fails as deterministic, the error naming which.
  *Held by `worker-service/pdf`.*
- **N6.** A job its agent's filters do not take, handed over all the same, is
  started and then failed as deterministic, the error naming the job. Nothing
  is read for it.
  *Held by `worker-service/declines`.*
- **N7.** A tagging job handed over without the schema its `schemaId` names
  fails as deterministic.
  *Held by `worker-service/declines`.*
- **N8.** A `mark` job on a resource the record does not have fails with no
  class, with the record's own message as its error.
  *Held by `worker-service/declines`.*

## Failures

- **F1.** Anything that stops a job's work becomes its `job:fail`
  ([WORKER-CONTRACT L4](./WORKER-CONTRACT.md#the-lifecycle)): the error as
  text, the failure's class when the service knows one, and `willRetry` as
  the claimed record's budget and that class make it. After it the service
  claims again.
  *Held by `worker-service/failures`.*
- **F2.** A failure carries the checkpoint the job last stated
  ([D13 and D14](#committing-and-where-a-job-stands)): the cursor of each
  unit the job has begun, in `unitCursors`, a finished type's among them, and
  the entity types this attempt of a linking job finished, in
  `completedUnits`. A job that had established nothing on this attempt carries
  neither.
  *Held by `worker-service/failures`.*
- **F3.** A generation the provider refuses fails the job in the class its
  status gives, as
  [`failure-class-cases.json`](../../specs/src/worker/failure-class-cases.json)
  states it: transient for a status the job rule retries (408, 429, and every
  status from 500 up), and deterministic for any other status of 400 or more.
  The error says what the provider said: its status and its body. On an
  Ollama agent the request is not made again within the attempt; on an
  Anthropic agent it may be ([F10](#failures)), and the job fails by the last
  answer. A failure of the provider that carries no status has no class: a
  connection that ends unanswered, and limits that cannot be learned,
  whatever was answered in their place.
  *Held by `worker-service/failures`, `worker-service/anthropic`.*
- **F4.** An answer that cannot be read, from a model that finished, has no
  class: one that is not JSON, one that is JSON and not an array, and one
  with nothing in it. Over a text that fits one piece the request is made
  once. An answer with nothing in it cannot be read whatever was asked for: a
  `yield` job whose model answers nothing fails so, and uploads nothing.
  *Held by `worker-service/failures`, `worker-service/anthropic`.*
- **F5.** An answer the model was cut off in (Ollama's `done_reason`
  `length`, Anthropic's `stop_reason` `max_tokens`) is not used, whatever it
  carried. Over a piece that cannot be cut smaller the same request is made a
  second time, and no more; cut off again, the job fails as deterministic.
  *Held by `worker-service/failures`, `worker-service/anthropic`.*
- **F6.** A piece that can be cut smaller is asked again in halves when its
  answer is cut off: pieces of half the size, cut as [D4](#pieces) cuts them,
  each asked in turn, and what they find taken together as the one piece's.
  The batch and the cursor are the piece's, and the cursor states the size
  the piece was first cut at. A half is halved in its turn for as long as the
  half of it is over 128 tokens. The piece after one that was halved is cut at
  seven tenths the size.
  *Held by `worker-service/halved`.*
- **F7.** A piece whose answer cannot be read, or is not had in time, is
  asked again in halves as [F6](#failures) says: one unreadable for a reason
  the provider does not state for as long as one cut off is, and any other
  twice at most.
  *Held by no case.*
- **F8.** A commit the record refuses fails the job with the record's reason,
  with no class, and the unit's cursor is not said
  ([WORKER-CONTRACT A5](./WORKER-CONTRACT.md#committing-annotations)).
  *Held by `worker-service/failures`.*
- **F9.** A generation is given ten minutes. One not answered by then is
  ended, and when no smaller piece is to be asked for instead
  ([F6](#failures)) the job fails as transient. While a detection awaits a
  generation, it reports where it stands again every fifteen seconds. On an
  Anthropic agent the ten minutes are of every asking of the one generation
  ([F10](#failures)) and of the waits between them.
  *Held by no case.*
- **F10.** An Anthropic agent asks again, within the attempt, for a request
  its provider refused with 408, 409, 429 or a status of 500 or more, and for
  one whose connection ended unanswered: the same request, twice more at
  most, three askings in all. This is so of every request it makes: a
  generation, and each of the two that learn a model's limits
  ([M5](#limits)). A request answered on a later asking is answered, and
  nothing is said of the refusals before it. One refused or ended all three
  times fails as [F3](#failures) says. A request refused with any other
  status is not made again.
  *Held by `worker-service/anthropic`.*
- **F11.** Before it asks again an Anthropic agent waits: as long as the
  refusal's `retry-after` says, in seconds, when it says; and otherwise at
  least three eighths of a second before the second asking and at least
  three quarters before the third.
  *Held by `worker-service/anthropic`.*
- **F12.** An answer the provider withheld (Anthropic's `stop_reason`
  `refusal`) is not used, whatever it carried: no annotation is made from it
  and no document is kept of it. The job fails as deterministic, its error
  saying that the answer was withheld and what the provider said of why, and
  the request is not made again.
  *Held by `worker-service/anthropic`.*

## Resuming

- **U1.** A job claimed with a cursor for a unit
  ([WORKER-CONTRACT R2](./WORKER-CONTRACT.md#the-claimed-record)) takes that
  unit up at the cursor's `next`: nothing before it is asked about again. Its
  first piece is cut at seven tenths of the cursor's `size`, held within the
  bounds of [D7](#pieces). The unit's counts begin at the cursor's, so the
  job's result and its progress are the whole text's. A unit whose cursor
  stands at the length of the text has nothing left: no piece of it is asked
  about, and it is counted by its cursor. A linking job names such an entity
  type finished when it comes to it, in a checkpoint that carries that cursor
  ([D14](#committing-and-where-a-job-stands)).
  *Held by `worker-service/resume`.*
- **U2.** A linking job claimed with finished entity types does not do them
  again: it asks only for the others, and counts every type. A finished type
  is counted by the cursor the claimed record holds for it: its `found`,
  `emitted` and `errors` are in the job's result, and in `entitiesFound` and
  `entitiesEmitted` from the first report. The type is among the finished
  from the first report: in `processed`, and in `completedItems`, ahead of the
  types this attempt finishes and in the job's order, with its cursor's
  `found` and `emitted` as its `foundCount` and `persistedCount`. A finished
  type the record holds no cursor for is not done again either, and counts
  nothing: it is in `processed`, it is not in `completedItems`, and it adds
  nothing to the job's counts. What a cursor does not carry is this attempt's
  alone: `entitiesExpected`, a type's `underReported` and the result's
  `underReportedPieces` ([K5](#the-five-kinds-of-mark-job)) are of the pieces
  this attempt asked about.
  *Held by `worker-service/resume`.*
- **U3.** Every lifecycle message of a resumed job states its attempt: the
  claimed record's `retryCount` and one.
  *Held by `worker-service/resume`.*

## Cancellation

Every job stops for a cancellation that names it
([WORKER-CONTRACT X1](./WORKER-CONTRACT.md#cancellation)): at its next
stopping place, and not at once.

- **Q1.** A `mark` job, of any motivation, stops after the piece it is on.
  That piece's batch is committed and checkpointed as any piece's is
  ([D13](#committing-and-where-a-job-stands), and
  [D14](#committing-and-where-a-job-stands) where it is the last piece of a
  linking job's entity type); no other piece is asked about; and the job is
  settled with `job:cancel`. A job that is on no piece when the cancellation
  arrives asks about none.
  *Held by `worker-service/cancel`.*
- **Q2.** `job:cancel` names, in `completedUnits`, the units the job had
  finished, and states none when it had finished none. A unit it was partway
  through is not named, and neither is an entity type the record a linking
  job was claimed with already names as finished. A job with nothing left to
  do but settle when the cancellation arrives is settled with `job:cancel`
  all the same, every unit named: a job cancelled on the last piece of its
  last unit, of whatever motivation.
  *Held by `worker-service/cancel`.*
- **Q3.** A `yield` job stops before it uploads. When the cancellation has
  arrived by the time its model has answered, nothing is uploaded, nothing is
  committed, and the job is settled with `job:cancel`. Once the upload has
  been sent the job runs to its end and is settled as it would have been.
  *Held by `worker-service/cancel`.*
- **Q4.** A cancellation does not interrupt a generation that is under way:
  the request to the provider is not ended, and the job stops at the next of
  the places above. So a cancelled job holds its agent, and its provider goes
  on working on an answer nobody will use, until the model answers or the
  ten-minute bound of [F9](#failures) ends the request. A cancellation can
  take that long to take effect.
  *Held by `worker-service/cancel`, `worker-service/anthropic`.*
- **Q5.** A cancelled job reports no completion: no `complete-created` and no
  `complete-generated`. Once it has stopped it makes no progress report at
  all: a `mark` job, none after the checkpoint of the piece it stopped on; a
  `yield` job, none after its model has answered.
  *Held by `worker-service/cancel`.*

## Generation

A `yield` job makes a resource. Its params are a
[`GenerationJobParams`](../../specs/src/components/schemas/GenerationJobParams.json):
what to write, where to store it, and the context gathered for it, which is
focused on a resource or on an annotation.

- **Y1.** A job for an `outputMediaType` the
  [media-type registry](../../specs/src/media-types/registry.json) does not
  mark `generatable` fails as deterministic, before anything is asked of the
  model. With none stated, the job writes `text/markdown`.
  *Held by `worker-service/yield`.*
- **Y2.** A generation to a text format is one request, which asks for no
  array of objects. Its temperature is the job's, or `0.7`, and its length
  the job's `maxTokens`, or `500`. The prompt is made of the job's `title`,
  `prompt`, `entityTypes`, languages, `structure` and `cite`, and of its
  context. On an Ollama agent the request is [D1](#the-request)'s with no
  `format`: the length is `num_predict`, and `num_ctx` is as
  [D3](#the-request) works it out. There a job whose prompt and length are
  together over the model's `contextTokens`, in tokens as [D3](#the-request)
  counts them, fails as deterministic, and the generation is not asked for.
  *Held by `worker-service/yield`.*
- **Y3.** What the model answers is the document, less the white space at its
  ends and a code fence around it. When the model was cut off (Ollama's
  `done_reason` `length`, Anthropic's `stop_reason` `max_tokens`) the
  document is kept, and the job says `truncated`.
  *Held by `worker-service/yield`, `worker-service/anthropic`.*
- **Y4.** With `cite`, the model is asked to mark each claim with the id of
  its source, `[[<id>]]`. The marks are taken out of the document, each with
  the spaces and tabs before it. A mark whose id the context showed makes a
  citation of the claim before it: the sentence that ends at the mark, with
  its closing marks and without the white space around it, as
  [`citation-cases.json`](../../specs/src/worker/citation-cases.json) states
  a claim. A mark whose id the context did not show makes none.
  *Held by `worker-service/yield`.*
- **Y5.** The document is uploaded to the gateway, `POST /resources`, as the
  job's `title` in `name`, its media type in `format`, at the job's
  `storageUri` as given, with the job's `jobId`, the agent as `generator`,
  the job's `resourceId` as `sourceResourceId`, and, where the job has them,
  its `prompt` as `generationPrompt`, its `language` and its `entityTypes`.
  *Held by `worker-service/yield`.*
- **Y6.** A job focused on a resource then commits, on that resource, one
  annotation that links it to what was made. It is an annotation of the
  resource as a whole, as
  [`builder-cases.json`](../../specs/src/annotations/builder-cases.json)
  states one and every SDK's `annotationOfResource` builds it: `@context`,
  `type`, the agent as `generator` and `created` as [D11](#the-annotation)
  states them, and no `modified`; `motivation` `linking`; a `target` that is
  the source as its `source` and nothing else; and a body of `type`
  `SpecificResource`, `source` the new resource and `purpose` `linking`. Its
  `id` is derived as [D12](#the-annotation) derives one, from the source, its
  motivation, its body, and the empty string as its `anchor`: it is anchored
  nowhere on the source. A job focused on an annotation commits no such link:
  its upload states that annotation as `sourceAnnotationId`, and every
  lifecycle message of the job names it as `annotationId`.
  *Held by `worker-service/yield`.*
- **Y7.** The citations are committed on the new resource, as one batch: each
  the annotation of a span, as [D11](#the-annotation) states one, of
  `motivation` `linking`. Its `target` is of `type` `SpecificResource`, with
  the new resource as `source` and the claim as `selector`: a
  `TextPositionSelector` and a `TextQuoteSelector` of its `exact`, with no
  `prefix` and no `suffix`, offsets in the document as uploaded, in code
  points. Its body is of `type` `SpecificResource`, `source` the cited
  resource and `purpose` `linking`. Its `id` is derived as
  [D12](#the-annotation) derives one, from the new resource, its motivation,
  its body, and the claim's `anchor`.
  *Held by `worker-service/yield`.*
- **Y8.** A `yield` job reports `generating-resource` at 5, `creating-resource`
  at 95 and `complete-generated`, with `truncated`, at 100. Its result is the
  new resource's `resourceId`, the job's `title` as `resourceName`, and
  `truncated`.
  *Held by `worker-service/yield`.*
- **Y9.** On an Anthropic agent the request of [Y2](#generation) is
  [D20](#the-request)'s with no `output_config`: the length is `max_tokens`.
  The generation is asked for whatever the model's ceilings are: a job whose
  prompt and length are together over what the model reads is asked for all
  the same, and what the provider will not take it refuses
  ([F3](#failures)). A length over 21333, which the provider's library
  reckons at over ten minutes of writing, is asked for with `stream: true`,
  and its answer is read from the provider's stream of events: the text is
  the `text_delta`s of its text block, joined, and why the model stopped is
  the `stop_reason` of its `message_delta`. A length of 21333 or less is
  asked for without `stream`, and answered as one message. The job makes the
  same of either.
  *Held by `worker-service/anthropic`.*

## Telemetry

- **T1.** A service started with `OTEL_EXPORTER_OTLP_ENDPOINT` exports, as
  `semiont-worker`, exactly what
  [`specs/src/service-telemetry/telemetry.json`](../../specs/src/service-telemetry/telemetry.json)
  lists for the worker, and the rows of
  [`specs/src/sdk-telemetry/telemetry.json`](../../specs/src/sdk-telemetry/telemetry.json)
  the first names for it under `sdk`. Every span and metric it exports is one
  of those rows, of the row's kind, carrying only the row's attributes, and,
  where the row lists values, only those values; and every one of those rows
  that the service's work can make arrives, with every attribute the row does
  not mark as conditional.
  *Held by `worker-service/telemetry`.*
- **T2.** A job is a `job:{jobType}` span, from the claim that handed it over
  to its settle, and is counted (`semiont.job.outcome`) and timed
  (`semiont.job.duration`) by its type, its motivation when it is a `mark`
  job, and how it ended: `completed`, a declined job among them, `failed`, or
  `cancelled`.
  *Held by `worker-service/telemetry`.*
- **T3.** A generation is a span, `inference:structured` when it asks for an
  array of objects and `inference:text` when it does not, that names the
  agent's provider and model and the tokens asked for. It is counted
  (`semiont.inference.calls`) and timed once, by how it ended, however many
  times its request was made ([F10](#failures)). The tokens its provider
  reported for it are counted as reported (`semiont.inference.tokens`), what
  the model read as `input` and what it wrote as `output`, under the
  provider and the model. What learns a model's limits
  ([M2 and M5](#limits)) is no generation, and is not counted.
  *Held by `worker-service/telemetry`, `worker-service/anthropic`.*

## Environment

Beside its document, a Worker service reads its environment for its service
account (`SEMIONT_OIDC_CLIENT_ID` and `SEMIONT_OIDC_CLIENT_SECRET`,
[B3](#configuration)), for the keys its document names
([B4](#configuration)), and for the variables of this section. It reads no
other, beyond the standard variables an OpenTelemetry SDK reads on its own.

- **E1.** `OTEL_EXPORTER_OTLP_ENDPOINT` is the OTLP/HTTP collector the
  service's spans and metrics are exported to ([T1](#telemetry)). Without it,
  and without `OTEL_CONSOLE_EXPORTER`, the service exports nothing and writes
  no span or metric anywhere.
  *Held by `worker-service/environment`.*
- **E2.** Every message a job sends is in the job's trace: its `bus.emit`
  spans share the trace of the job's own span. Each job's trace is its own
  ([WORKER-CONTRACT T1](./WORKER-CONTRACT.md#traces)): the job's span
  continues the trace of the `job:claimed` that handed it over, the second
  job an agent runs is not in the trace of its first, and the claim an agent
  makes when it settles a job is not in that job's trace.
  *Held by `worker-service/environment`.*
- **E3.** `OTEL_SERVICE_NAME` is the `service.name` its spans and metrics
  carry; `semiont-worker` when unset.
  *Held by `worker-service/environment`.*
- **E4.** `OTEL_SDK_DISABLED` set to `true` exports nothing, whatever else is
  set.
  *Held by `worker-service/environment`.*
- **E5.** `OTEL_CONSOLE_EXPORTER` set to `true`, with no
  `OTEL_EXPORTER_OTLP_ENDPOINT`, writes spans and metrics to the service's
  output instead of exporting them.
  *Held by `worker-service/environment`.*
- **E6.** `OTEL_METRICS_EXPORTER` set to `console` writes metrics to the
  service's output, while spans still go to `OTEL_EXPORTER_OTLP_ENDPOINT`.
  *Held by `worker-service/environment`.*
- **E7.** `OTEL_METRIC_EXPORT_INTERVAL` is the milliseconds between metric
  exports; 30000 when unset.
  *Held by `worker-service/environment`.*
- **E8.** `OTEL_BSP_SCHEDULE_DELAY` is the milliseconds a finished span waits
  to be exported in a batch; 5000 when unset. The OpenTelemetry SDK reads it,
  not the service's own code.
  *Held by `worker-service/environment`.*
- **E9.** `SEMIONT_BUS_LOG`, with any value that is not empty, writes one line
  to the service's output for each frame it sends, beginning `[bus EMIT]
  <channel>`, and one for each frame it receives, beginning `[bus RECV]
  <channel>`. Unset, it writes none.
  *Held by `worker-service/environment`.*
- **E10.** `SUPERVISE_EVENTS` is the supervisor's events log, one `starting
  <name>` line for each life of the process, and `SUPERVISE_NAME` is that
  name. With both, the service reports `semiont.process.restarts`: the lives
  the log records, less one. Without either, the metric does not exist.
  *Held by `worker-service/environment`.*
- **E11.** `LOG_LEVEL` and `LOG_FORMAT` are not read. How much the service
  logs, and in which form, are its document's `logLevel` and `logFormat`.
  *Held by `worker-service/environment`.*

## Output

- **O1.** Every line a service that has started writes is a log line, on
  stdout, in the form its document's `logFormat` names
  ([`LogFormat`](../../specs/src/components/schemas/LogFormat.json)): what it
  reads of a model's answer and what it cannot anchor are log lines like any
  other. It writes nothing to stderr. Beside its log it writes only what
  [E5, E6 and E9](#environment) have it write.
  *Held by `worker-service/output`.*

## Stopping

- **P1.** On `SIGTERM` or `SIGINT` a service that holds no job says nothing
  more on the bus and exits with status 0. Its health answers no more.
  *Held by `worker-service/stop`.*
- **P2.** A service that holds a job fails it first
  ([WORKER-CONTRACT L8](./WORKER-CONTRACT.md#the-lifecycle)), claims no other,
  and exits with status 0. A request to its provider that is under way ends
  with the process, unanswered.
  *Held by `worker-service/stop`, `worker-service/anthropic`.*
- **P3.** A claim refused as `unauthorized` ends the service: it exits with
  status 1, for whatever supervises it to restart. A claim refused for any
  other reason does not: the service stays up and claims at its next idle
  moment ([WORKER-CONTRACT C7](./WORKER-CONTRACT.md#claiming)).
  *Held by `worker-service/stop`.*
- **P4.** A held job that stalls
  ([WORKER-CONTRACT V2](./WORKER-CONTRACT.md#liveness)) ends the service: it
  exits with status 1.
  *Held by no case.*
