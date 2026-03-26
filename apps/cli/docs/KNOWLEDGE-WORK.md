# Knowledge Work Commands

This guide covers the commands for knowledge work: `login`, `browse`, `gather`, `mark`, `match`, `bind`, `listen`, `yield`, and `beckon`.

For infrastructure management (`start`, `stop`, `provision`, etc.) see [Infrastructure Commands](./INFRASTRUCTURE.md).

---

## Authentication

All API commands read a cached token. Use `semiont login` to obtain one before running any other API command.

### login

Authenticates against a Semiont backend and caches the token at `$XDG_STATE_HOME/semiont/auth/<bus-slug>.json` (mode 0600). The token is valid for 24 hours. Multiple backends can be logged into simultaneously — tokens are keyed by bus URL.

```bash
semiont login --bus http://localhost:4000 --user alice@example.com
semiont login --bus https://api.acme.com   # prompts for password on TTY
semiont login --refresh --bus https://api.acme.com
```

**Credential resolution order (login only):**

1. `--bus` / `--user` / `--password` flags
2. `$SEMIONT_BUS` / `$SEMIONT_USER` / `$SEMIONT_PASSWORD`
3. `~/.semiontconfig` `[environments.<env>.auth]` bus / email / password
4. Interactive password prompt (TTY only)

| Flag | Short | Description |
|------|-------|-------------|
| `--bus <url>` | `-b` | Backend URL |
| `--user <email>` | `-u` | Login email |
| `--password <pw>` | | Login password (use interactive prompt instead of shell history) |
| `--refresh` | | Re-authenticate and overwrite the cached token |

---

## Common API Options

All API commands accept:

| Flag | Short | Description |
|------|-------|-------------|
| `--bus <url>` | `-b` | Backend URL. Fallback: `$SEMIONT_BUS` |

If no cached token exists for the resolved bus URL, the command fails with a clear error directing you to run `semiont login`.

---

## browse — Inspect the knowledge base

Human-readable traversal of resources, annotations, references, and events. JSON to stdout; progress labels to stderr.

```bash
# List resources
semiont browse resources
semiont browse resources --search "Paris"
semiont browse resources --entity-type Location --limit 20

# Inspect a resource
semiont browse resource <resourceId>
semiont browse resource <resourceId> --annotations
semiont browse resource <resourceId> --references

# Inspect an annotation
semiont browse annotation <resourceId> <annotationId>

# See what resources link to this one
semiont browse references <resourceId>

# Event log and annotation audit trail
semiont browse events <resourceId>
semiont browse history <resourceId> <annotationId>

# Available entity types
semiont browse entity-types

# Composable with jq
semiont browse resources | jq '.[]["@id"]'
semiont browse entity-types | jq '.[].tag'
```

Use `gather` (not `browse`) when feeding context into AI pipelines.

---

## gather — Fetch LLM-optimised context

Fetches a resource or annotation and returns structured context designed for LLM pipelines. Streams completion via SSE; result is JSON on stdout.

```bash
semiont gather resource <resourceId>
semiont gather resource <resourceId> --depth 2 --max-resources 20
semiont gather annotation <resourceId> <annotationId>
```

| Flag | Description |
|------|-------------|
| `--depth <n>` | Traversal depth for related resources (1–3, default 2) |
| `--max-resources <n>` | Maximum related resources to include |
| `--no-content` | Omit full resource content (return metadata only) |
| `--summary` | Return a summary instead of full content |
| `--context-window <n>` | Token budget hint for content truncation |

---

## mark — Create an annotation

Creates a W3C annotation on a resource. Manual mode lets you specify the selector and body; delegate mode asks an AI model to draft the annotation.

### Manual mode

```bash
# Highlight with a text quote selector
semiont mark <resourceId> --motivation highlighting --quote "key phrase"

# Text position selector
semiont mark <resourceId> --motivation highlighting --start 100 --end 250

# SVG selector (for images)
semiont mark <resourceId> --motivation highlighting --svg '<circle cx="50" cy="50" r="10"/>'

# Fragment selector (for media)
semiont mark <resourceId> --motivation highlighting --fragment "t=10,20"

# With a body
semiont mark <resourceId> --motivation commenting --quote "phrase" --body-text "my comment"
semiont mark <resourceId> --motivation linking --quote "Paris" --link <targetResourceId>
```

### Delegate mode (AI-assisted)

```bash
# Let AI find highlights
semiont mark <resourceId> --delegate --motivation highlighting

# Let AI find entity references
semiont mark <resourceId> --delegate --motivation linking --entity-type Person

# Let AI apply taxonomy tags
semiont mark <resourceId> --delegate --motivation tagging --schema-id science --category Biology
```

| Flag | Description |
|------|-------------|
| `--motivation <m>` | Required. One of: `highlighting`, `commenting`, `linking`, `tagging`, `assessing`, `describing` |
| `--delegate` | AI-assisted mode; mutually exclusive with `--quote` |
| `--quote <text>` | TextQuoteSelector |
| `--start <n>` / `--end <n>` | TextPositionSelector |
| `--svg <value>` | SvgSelector |
| `--fragment <value>` | FragmentSelector |
| `--body-text <text>` | TextualBody value |
| `--link <resourceId>` | SpecificResource body (repeatable) |
| `--entity-type <type>` | Entity type filter for delegate linking (repeatable) |
| `--schema-id <id>` | Taxonomy schema ID for delegate tagging |
| `--category <name>` | Taxonomy category for delegate tagging (repeatable) |

---

## match — Find binding candidates

Searches for candidate resources to bind to a linking annotation. Returns a ranked list.

```bash
semiont match <resourceId> <annotationId>
semiont match <resourceId> <annotationId> --limit 5
semiont match <resourceId> <annotationId> --user-hint "look for papers about Paris"
semiont match <resourceId> <annotationId> --no-semantic  # keyword-only search
```

| Flag | Description |
|------|-------------|
| `--limit <n>` | Maximum results (default 10) |
| `--user-hint <text>` | Natural-language hint to guide the search |
| `--no-semantic` | Disable semantic (embedding) search |
| `--context-window <n>` | Token budget hint for context gathering |

---

## bind — Resolve a linking annotation

Final step of the gather → match → bind pipeline. Adds a `SpecificResource` body item pointing to the chosen target.

```bash
semiont bind <resourceId> <annotationId> <targetResourceId>

# Typical pipeline
TARGET=$(semiont match <resourceId> <annotationId> --quiet | jq -r '.[0]["@id"]')
semiont bind <resourceId> <annotationId> "$TARGET"
```

---

## listen — Stream domain events

Opens a persistent SSE connection and prints domain events as NDJSON (one JSON object per line). Runs until Ctrl-C or the server closes the connection.

```bash
# All system events
semiont listen

# Events for a specific resource
semiont listen resource <resourceId>

# Composable
semiont listen | jq .type
semiont listen resource <resourceId> | grep annotation
```

---

## yield — Upload or generate a resource

**Upload mode** — register a local file as a new resource:

```bash
semiont yield --upload ./paper.pdf
semiont yield --upload ./paper.pdf --name "My Paper"
semiont yield --upload ./a.md --upload ./b.md   # multiple files
```

**Delegate mode** — use an AI model to generate a new resource from annotation context:

```bash
semiont yield --delegate \
  --resource <resourceId> \
  --annotation <annotationId> \
  --storage-uri file://generated/output.md
```

| Flag | Description |
|------|-------------|
| `--upload <path>` | File to upload (repeatable) |
| `--name <name>` | Resource name (upload mode, single file only) |
| `--delegate` | AI-generation mode; mutually exclusive with `--upload` |
| `--resource <id>` | Source resource for delegate mode |
| `--annotation <id>` | Source annotation for delegate mode |
| `--storage-uri <uri>` | Where to store the generated output |
| `--prompt <text>` | Override the generation prompt |
| `--temperature <n>` | Model temperature (0–1) |
| `--max-tokens <n>` | Maximum tokens to generate |
| `--context-window <n>` | Token budget for context gathering |

---

## beckon — Direct attention

Directs a participant's attention to a resource or annotation.

```bash
semiont beckon <resourceId>
semiont beckon <resourceId> <annotationId>
```

---

## Further Reading

- [Infrastructure Commands](./INFRASTRUCTURE.md) — service lifecycle, deployment, backup/restore
- [Architecture Overview](./ARCHITECTURE.md)
- [Managing Environments](./ADDING_ENVIRONMENTS.md)
