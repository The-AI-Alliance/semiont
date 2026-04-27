---
name: semiont-cli
description: Help users accomplish knowledge work tasks using the Semiont CLI
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, Grep
---

You are helping a user work with a Semiont knowledge base using the `semiont` CLI.

Semiont is a knowledge system where humans and AI agents collaborate as peers. Documents (resources) are stored in a knowledge base and enriched with W3C Web Annotations — highlights, comments, tags, and entity references. The CLI is the primary tool for this work. All commands talk to a running Semiont backend via a cached auth token.

## Authentication

Before any API command will work, the user must be logged in:

```bash
semiont login --bus http://localhost:4000 --user alice@example.com
semiont login --bus https://api.acme.com   # interactive password prompt
semiont login --refresh --bus https://api.acme.com
```

Tokens are cached at `$XDG_STATE_HOME/semiont/auth/<bus-slug>.json` and are valid for 24 hours. If a command fails with an auth error, prompt the user to run `semiont login` first.

All API commands accept `--bus <url>` (short: `-b`) to target a specific backend. Falls back to `$SEMIONT_BUS`.

---

## Primary workflow

The core pipeline is: **mark → gather → match → bind**. Detect entity references in a document, assemble context around each one, search the KB for a match, and link the annotation to its target. When no match exists, `yield --delegate` generates a new resource and binds to it.

```bash
# 1. Detect entity references (AI-assisted)
semiont mark "$RESOURCE_ID" --delegate --motivation linking \
  --entity-type Location --entity-type Person

# 2. For each unresolved annotation, find candidates
semiont match "$RESOURCE_ID" "$ANN_ID"

# 3. Bind to the best match
semiont bind "$RESOURCE_ID" "$ANN_ID" "$TARGET_ID"

# 4. Or generate a new resource if no good match exists
semiont yield --delegate --resource "$RESOURCE_ID" --annotation "$ANN_ID" \
  --storage-uri file://generated/output.md
```

The `semiont-wiki` skill runs this pipeline end-to-end as a shell script.

---

## browse — Inspect the knowledge base

| Want to… | Use |
|----------|-----|
| See what's on disk (tracked or not) | `browse files [path]` |
| List resources in the KB | `browse resources` |
| Inspect one resource | `browse resource <id>` |
| See annotations on a resource | `browse resource <id> --annotations` |
| Find what links to a resource | `browse references <id>` |
| See available entity types | `browse entity-types` |

```bash
semiont browse resources
semiont browse resources --search "Paris"
semiont browse resources --entity-type Location --limit 20
semiont browse resource <resourceId>
semiont browse resource <resourceId> --annotations
semiont browse resource <resourceId> --references
semiont browse annotation <resourceId> <annotationId>
semiont browse references <resourceId>
semiont browse events <resourceId>
semiont browse history <resourceId> <annotationId>
semiont browse entity-types
semiont browse files
semiont browse files docs
semiont browse files docs --sort mtime
semiont browse files --sort annotationCount
```

`browse files` lists a project directory, merging live filesystem entries with KB metadata. Each entry is marked `tracked: true/false`. Dotfiles and `.semiont/` are excluded. Paths that escape the project root are rejected. `--sort` accepts `name` (default), `mtime`, `annotationCount`.

```bash
semiont browse files | jq '.entries[] | select(.tracked) | .name'
```

---

## gather — Fetch context for downstream workers

Use `gather` instead of `browse` when feeding data into automation or pipelines.

```bash
semiont gather resource <resourceId>
semiont gather annotation <resourceId> <annotationId>
```

---

## mark — Create an annotation

**Delegate mode** is the primary path for bulk annotation — an AI worker scans the document and creates annotations automatically. **Manual mode** is for one-off corrections or additions.

```bash
# Delegate — AI worker detects and creates annotations
semiont mark <resourceId> --delegate --motivation highlighting
semiont mark <resourceId> --delegate --motivation linking --entity-type Person --entity-type Place
semiont mark <resourceId> --delegate --motivation tagging --schema-id science --category Biology

# Manual — specify selector and body directly
semiont mark <resourceId> --motivation highlighting --quote "key phrase"
semiont mark <resourceId> --motivation commenting --quote "phrase" --body-text "my comment"
semiont mark <resourceId> --motivation linking --quote "Paris" --link <targetResourceId>
```

Motivations: `highlighting`, `commenting`, `linking`, `tagging`, `assessing`, `describing`.

---

## match / bind — Resolve a reference

```bash
semiont match <resourceId> <annotationId>
semiont match <resourceId> <annotationId> --user-hint "look for papers about Paris"
semiont bind <resourceId> <annotationId> <targetResourceId>

# Typical pipeline
TARGET=$(semiont match <resourceId> <annotationId> --quiet | jq -r '.[0]["@id"]')
semiont bind <resourceId> <annotationId> "$TARGET"
```

---

## listen — Stream domain events

```bash
semiont listen
semiont listen resource <resourceId>
semiont listen | jq .type
```

---

## yield — Upload or generate a resource

```bash
# Upload a local file
semiont yield --upload ./paper.pdf
semiont yield --upload ./paper.pdf --name "My Paper"
semiont yield --upload ./a.md --upload ./b.md

# Generate a new resource from an annotation's context
semiont yield --delegate \
  --resource <resourceId> \
  --annotation <annotationId> \
  --storage-uri file://generated/output.md
```

---

## beckon — Direct another participant's attention

Sends a focus signal to a named participant connected to the backend. Ephemeral — dropped if the participant is not connected.

```bash
semiont beckon <resourceId>
semiont beckon <resourceId> <annotationId>
```

---

## Guidance for the AI assistant

- **Resolve IDs before acting.** If the user refers to a resource by name, use `semiont browse resources --search "<name>"` to find the ID first.
- **Check auth early.** If a command fails unexpectedly, check whether the token is missing or expired (`semiont login`).
- **Compose with jq.** All commands emit JSON to stdout. Suggest jq pipelines for filtering, extracting IDs, or chaining commands.
- **`browse files` vs `browse resources`.** `browse files` shows what is *on disk* (tracked or not); `browse resources` shows only what is *in the KB*. Use `browse files` when the user wants to see their project directory or find untracked files.
- **Delegate before manual for `mark`.** Suggest `--delegate` when the user wants to annotate a whole document. Manual mode is for targeted corrections.
- **The gather → match → bind pipeline** is the standard pattern for resolving unresolved reference annotations. Walk the user through the three steps in order, or point them to the `semiont-wiki` skill for full automation.
- **`beckon` coordinates attention between participants**, not navigation within the app. It is useful for directing a human reviewer's attention to a specific annotation from a script or agent.
